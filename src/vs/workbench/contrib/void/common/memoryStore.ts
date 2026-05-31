/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js'
import { Disposable } from '../../../../base/common/lifecycle.js'
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js'
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js'
import { IFileService } from '../../../../platform/files/common/files.js'
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js'
import { VSBuffer } from '../../../../base/common/buffer.js'
import { AgentTask, MemoryEntry, ProjectMemory } from './agentPipelineTypes.js'

const MEMORY_DIR = '.void'
const MEMORY_FILE = 'memory.json'
const MAX_ENTRIES = 20
const MAX_NON_DECISION_ENTRIES = 12

// ======================== Service Interface ========================

export interface IMemoryStore {
	readonly _serviceBrand: undefined
	load(): Promise<void>
	save(): Promise<void>
	getMemory(): ProjectMemory
	addEntry(entry: Omit<MemoryEntry, 'id' | 'timestamp'>): Promise<void>
	updateProjectInfo(summary: string, techStack: string[]): Promise<void>
	updateFileIndex(updates: Record<string, string>): Promise<void>
	buildContextString(taskContext: AgentTask, maxTokens?: number): string
	clearMemory(): Promise<void>
}

export const IMemoryStore = createDecorator<IMemoryStore>('AgentMemoryStore')

// ======================== Implementation ========================

function createEmptyMemory(): ProjectMemory {
	return {
		projectSummary: '',
		techStack: [],
		entries: [],
		fileIndex: {},
		lastUpdated: Date.now(),
	}
}

// Rough token estimation: ~4 chars per token
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4)
}

function truncateToTokenBudget(text: string, maxTokens: number): string {
	const maxChars = maxTokens * 4
	if (text.length <= maxChars) return text
	return text.slice(0, maxChars - 3) + '...'
}

export class MemoryStore extends Disposable implements IMemoryStore {
	readonly _serviceBrand: undefined

	private memory: ProjectMemory = createEmptyMemory()
	private memoryURI: URI | null = null

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super()
	}

	private _getMemoryURI(): URI | null {
		const folders = this._workspaceContextService.getWorkspace().folders
		if (folders.length === 0) return null
		return URI.joinPath(folders[0].uri, MEMORY_DIR, MEMORY_FILE)
	}

	async load(): Promise<void> {
		const uri = this._getMemoryURI()
		if (!uri) {
			this.memory = createEmptyMemory()
			return
		}
		this.memoryURI = uri

		try {
			const content = await this._fileService.readFile(uri)
			const raw = content.value.toString()
			this.memory = JSON.parse(raw) as ProjectMemory
		} catch {
			// First run or corrupted: initialize fresh
			this.memory = createEmptyMemory()
		}
	}

	async save(): Promise<void> {
		const uri = this.memoryURI ?? this._getMemoryURI()
		if (!uri) return
		this.memoryURI = uri

		this.memory.lastUpdated = Date.now()
		const content = JSON.stringify(this.memory, null, 2)

		// Create .void directory if it doesn't exist
		const dirURI = URI.joinPath(uri, '..')
		try {
			await this._fileService.createFolder(dirURI)
		} catch {
			// Directory might already exist, that's fine
		}

		await this._fileService.writeFile(uri, VSBuffer.fromString(content))
	}

	getMemory(): ProjectMemory {
		return this.memory
	}

	async addEntry(entry: Omit<MemoryEntry, 'id' | 'timestamp'>): Promise<void> {
		this.memory.entries.push({
			...entry,
			id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
			timestamp: Date.now(),
		})
		this._cleanMemory()
		await this.save()
	}

	async updateProjectInfo(summary: string, techStack: string[]): Promise<void> {
		this.memory.projectSummary = summary
		this.memory.techStack = techStack
		await this.save()
	}

	async updateFileIndex(updates: Record<string, string>): Promise<void> {
		for (const [path, desc] of Object.entries(updates)) {
			this.memory.fileIndex[path] = desc
		}
		await this.save()
	}

	/**
	 * Builds a context string from memory, tailored for the current task.
	 * Type-aware selection: always includes decisions/architecture,
	 * drops oldest file_created entries first.
	 */
	buildContextString(taskContext: AgentTask, maxTokens = 800): string {
		const memory = this.memory
		const parts: string[] = []

		// Always include (never trimmed):
		if (memory.projectSummary) {
			parts.push(`PROJECT: ${memory.projectSummary}`)
		}
		if (memory.techStack.length > 0) {
			parts.push(`STACK: ${memory.techStack.join(', ')}`)
		}

		// Always include architecture decisions (last 5 max):
		const decisions = memory.entries
			.filter(e => e.type === 'decision' || e.type === 'architecture')
			.slice(-5)
			.map(e => `• ${e.text}`)
		if (decisions.length) {
			parts.push(`KEY DECISIONS:\n${decisions.join('\n')}`)
		}

		// Files touched by current task only:
		const relevantFiles = taskContext.targetFiles
			.filter(f => memory.fileIndex[f])
			.map(f => `${f} → ${memory.fileIndex[f]}`)
		if (relevantFiles.length) {
			parts.push(`RELEVANT FILES:\n${relevantFiles.join('\n')}`)
		}

		// Recent completed work (last 4 only):
		const recentWork = memory.entries
			.filter(e => e.type === 'file_created' || e.type === 'fix')
			.slice(-4)
			.map(e => `[done] ${e.text}`)
		if (recentWork.length) {
			parts.push(`RECENT WORK:\n${recentWork.join('\n')}`)
		}

		const full = parts.join('\n\n')
		return truncateToTokenBudget(full, maxTokens)
	}

	async clearMemory(): Promise<void> {
		this.memory = createEmptyMemory()
		await this.save()
	}

	/**
	 * Cleanup: keep all decision/architecture entries,
	 * trim oldest non-decision entries to MAX_NON_DECISION_ENTRIES.
	 * Total entries capped at MAX_ENTRIES.
	 */
	private _cleanMemory(): void {
		const decisions = this.memory.entries.filter(e =>
			e.type === 'decision' || e.type === 'architecture'
		)
		const others = this.memory.entries
			.filter(e => e.type !== 'decision' && e.type !== 'architecture')
			.slice(-MAX_NON_DECISION_ENTRIES)

		this.memory.entries = [...decisions, ...others].slice(-MAX_ENTRIES)
	}
}

registerSingleton(IMemoryStore, MemoryStore, InstantiationType.Eager)
