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
import { AgentTask, AgentSessionState, MemoryEntry, ProjectMemory, TaskHistoryEntry, TaskOutcome, createEmptySessionState } from './agentPipelineTypes.js'
import { parseToolCallsFromText, buildTaskSummary } from './toolCallParser.js'

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
	getTaskHistory(): TaskHistoryEntry[]
	archiveCompletedTasks(tasks: AgentTask[]): Promise<void>
	buildContextString(taskContext: AgentTask, maxTokens?: number): string
	clearMemory(): Promise<void>
	// Session state management (deterministic, per-pipeline)
	startSession(workspaceRoot: string): Promise<void>
	recordTaskOutcome(task: AgentTask, agentOutputText: string): Promise<TaskOutcome>
	recordTaskOutcomeFromParsed(task: AgentTask, outcome: TaskOutcome): Promise<TaskOutcome>
	getSessionState(): AgentSessionState | null
	buildSessionContextBlock(): string
}

export const IMemoryStore = createDecorator<IMemoryStore>('AgentMemoryStore')

// ======================== Implementation ========================

function createEmptyMemory(): ProjectMemory {
	return {
		projectSummary: '',
		techStack: [],
		entries: [],
		taskHistory: [],
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

/**
 * Adaptive prune: given context parts, trim to fit the token budget.
 * Prunes in priority order (lowest priority dropped first):
 *   1. Drop past session history (last part, least priority)
 *   2. Drop file index
 *   3. Keep decisions + summary always
 */
function adaptivePrune(parts: string[], maxTokens: number): string {
	// Try all parts first
	let full = parts.join('\n\n')
	if (estimateTokens(full) <= maxTokens) return full

	// Drop past session history (last part added, least priority)
	if (parts.length > 1) {
		const withoutHistory = parts.slice(0, -1).join('\n\n')
		if (estimateTokens(withoutHistory) <= maxTokens) return withoutHistory
	}

	// Drop file index too
	if (parts.length > 2) {
		const withoutFileIndex = parts.slice(0, -2).join('\n\n')
		if (estimateTokens(withoutFileIndex) <= maxTokens) return withoutFileIndex
	}

	// Last resort: truncate to just the first 2 parts (project + stack)
	return truncateToTokenBudget(parts.slice(0, 2).join('\n\n'), maxTokens)
}

export class MemoryStore extends Disposable implements IMemoryStore {
	readonly _serviceBrand: undefined

	private memory: ProjectMemory = createEmptyMemory()
	private memoryURI: URI | null = null
	private sessionState: AgentSessionState | null = null
	private sessionStateURI: URI | null = null

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

	getTaskHistory(): TaskHistoryEntry[] {
		return this.memory.taskHistory || []
	}

	async archiveCompletedTasks(tasks: AgentTask[]): Promise<void> {
		const completed = tasks.filter(t => t.status === 'done' || t.status === 'failed')
		if (completed.length === 0) return

		const newEntries: TaskHistoryEntry[] = completed.map(t => ({
			taskId: t.id,
			title: t.title,
			description: t.description.length > 200 ? t.description.slice(0, 200) + '...' : t.description,
			status: t.status,
			result: t.result || t.error,
			timestamp: Date.now(),
		}))

		this.memory.taskHistory = [...(this.memory.taskHistory || []), ...newEntries]
		this._cleanMemory()
		await this.save()
	}

	/**
	 * Builds a context string from LONG-TERM memory, tailored for the current task.
	 * Reduced token budget: session state (buildSessionContextBlock) now covers "what happened this run".
	 * This method focuses on CROSS-SESSION knowledge only: project summary, tech stack,
	 * architectural decisions, file index for target files, and past session history.
	 */
	buildContextString(taskContext: AgentTask, maxTokens = 350): string {
		const memory = this.memory
		const parts: string[] = []

		// Always include (never trimmed):
		if (memory.projectSummary) {
			parts.push(`PROJECT: ${memory.projectSummary}`)
		}
		if (memory.techStack.length > 0) {
			parts.push(`STACK: ${memory.techStack.join(', ')}`)
		}

		// Architectural decisions — always include, these affect all code
		const decisions = memory.entries
			.filter(e => e.type === 'decision' || e.type === 'architecture')
			.slice(-4)
			.map(e => `  - ${e.text}`)
		if (decisions.length) {
			parts.push(`KEY DECISIONS (follow these):\n${decisions.join('\n')}`)
		}

		// Files relevant to THIS task specifically — help the model know they exist
		const relevantFiles = taskContext.targetFiles
			.filter(f => memory.fileIndex[f])
			.map(f => `  ${f}: ${memory.fileIndex[f]}`)
		if (relevantFiles.length) {
			parts.push(`RELEVANT FILES (read before editing):\n${relevantFiles.join('\n')}`)
		}

		// Cross-session prerequisite knowledge — files that may already exist from previous sessions
		const prereqs: string[] = []
		for (const targetFile of taskContext.targetFiles) {
			const description = memory.fileIndex[targetFile]
			if (description && !relevantFiles.some(r => r.includes(targetFile))) {
				prereqs.push(`${targetFile}: ${description} (from previous session)`)
			}
		}
		if (prereqs.length > 0) {
			parts.push(`FILES FROM PREVIOUS SESSIONS (may already exist — check before creating):\n${prereqs.map(p => `  ${p}`).join('\n')}`)
		}

		// Past session history — only include if there's no session state already covering it
		const history = (memory.taskHistory || [])
			.slice(-3)
			.map(t => `  [${t.status}] ${t.title}`)
		if (history.length) {
			parts.push(`FROM PREVIOUS SESSIONS:\n${history.join('\n')}`)
		}

		// NOTE: "RECENT WORK (This Session)" is no longer included here.
		// That is covered by buildSessionContextBlock() with exact paths.

		return adaptivePrune(parts, maxTokens)
	}

	// ======================== Session State (Deterministic) ========================

	async startSession(workspaceRoot: string): Promise<void> {
		this.sessionState = createEmptySessionState(workspaceRoot)
		const uri = this._getMemoryURI()
		if (uri) {
			this.sessionStateURI = URI.joinPath(uri, '..', 'session_state.json')
			await this._saveSessionState()
		}
	}

	async recordTaskOutcome(task: AgentTask, agentOutputText: string): Promise<TaskOutcome> {
		if (!this.sessionState) return this._makeEmptyOutcome(task)

		const parsed = parseToolCallsFromText(agentOutputText, task.id)
		const summary = buildTaskSummary(task.title, parsed)

		const outcome: TaskOutcome = {
			taskId: task.id,
			title: task.title,
			status: 'done',
			filesCreated: parsed.filesCreated,
			filesModified: parsed.filesModified,
			packagesInstalled: parsed.packagesInstalled,
			summary,
		}

		// Accumulate into session-wide lists (deduplicated)
		for (const f of parsed.filesCreated) {
			if (!this.sessionState.allCreatedFiles.includes(f)) {
				this.sessionState.allCreatedFiles.push(f)
			}
		}
		for (const f of parsed.filesModified) {
			if (!this.sessionState.allModifiedFiles.includes(f) &&
				!this.sessionState.allCreatedFiles.includes(f)) {
				this.sessionState.allModifiedFiles.push(f)
			}
		}
		for (const pkg of parsed.packagesInstalled) {
			const exists = this.sessionState.allInstalledPackages
				.some(p => p.manager === pkg.manager && p.name === pkg.name)
			if (!exists) this.sessionState.allInstalledPackages.push(pkg)
		}

		this.sessionState.taskOutcomes.push(outcome)
		this.sessionState.lastUpdated = Date.now()
		await this._saveSessionState()
		return outcome
	}

	getSessionState(): AgentSessionState | null {
		return this.sessionState
	}

	/**
	 * Builds the imperative session context block injected BEFORE every task.
	 * Uses "DO NOT" language — informational phrasing does not work for 7B models.
	 * This is the primary fix for duplicate file creation and package reinstallation.
	 */
	buildSessionContextBlock(): string {
		const s = this.sessionState
		if (!s) return ''

		const parts: string[] = []

		// CRITICAL: workspace context at the top
		if (s.workspaceRoot) {
			parts.push(`WORKSPACE ROOT: ${s.workspaceRoot}`)
		}
		if (s.lastKnownCwd && s.lastKnownCwd !== s.workspaceRoot) {
			parts.push(`LAST USED DIRECTORY: ${s.lastKnownCwd}\n(Use this as cwd for related commands unless you need a different directory)`)
		}

		// Files already created — IMPERATIVE, not informational
		if (s.allCreatedFiles.length > 0) {
			parts.push(
				'FILES ALREADY CREATED THIS SESSION — DO NOT use <create_file> for these.\n' +
				'If you need to change them, use <edit_file> or <rewrite_file> instead:\n' +
				s.allCreatedFiles.map(f => `  ${f}`).join('\n')
			)
		}

		// Files modified (only last 8 to stay compact)
		if (s.allModifiedFiles.length > 0) {
			const recent = s.allModifiedFiles.slice(-8)
			parts.push(
				'FILES MODIFIED THIS SESSION (read before editing):\n' +
				recent.map(f => `  ${f}`).join('\n')
			)
		}

		// Packages installed — IMPERATIVE
		if (s.allInstalledPackages.length > 0) {
			const byManager: Record<string, string[]> = {}
			for (const pkg of s.allInstalledPackages) {
				if (!byManager[pkg.manager]) byManager[pkg.manager] = []
				byManager[pkg.manager].push(pkg.name)
			}
			const lines = Object.entries(byManager)
				.map(([mgr, names]) => `  ${mgr}: ${names.join(', ')}`)
			parts.push(
				'PACKAGES ALREADY INSTALLED — DO NOT reinstall these:\n' + lines.join('\n')
			)
		}

		// Failed commands — prevent repetition
		if (s.failedCommands && s.failedCommands.length > 0) {
			const recent = s.failedCommands.slice(-3)
			const lines = recent.map(f => `  \u2717 "${f.command}" in ${f.cwd} — ERROR: ${f.errorSnippet}`)
			parts.push(`COMMANDS THAT FAILED — DO NOT repeat these:\n${lines.join('\n')}`)
		}

		// Task outcomes (last 5, most recent first)
		if (s.taskOutcomes.length > 0) {
			const recent = s.taskOutcomes.slice(-5)
			const lines = recent.map((o, i) =>
				`  ${i + 1}. [${o.status.toUpperCase()}] ${o.summary}`
			)
			parts.push('WHAT HAS BEEN DONE (DO NOT redo):\n' + lines.join('\n'))
		}

		if (parts.length === 0) return ''

		return [
			'=== SESSION MEMORY (read carefully before acting) ===',
			parts.join('\n\n'),
			'=== END SESSION MEMORY ===',
		].join('\n')
	}

	private _makeEmptyOutcome(task: AgentTask): TaskOutcome {
		return {
			taskId: task.id, title: task.title, status: 'done',
			filesCreated: [], filesModified: [], packagesInstalled: [],
			summary: task.title,
		}
	}

	/**
	 * Record a task outcome from pre-parsed data (bypasses broken text parser).
	 * Called from the rewritten _extractMemory in agentPipelineService.
	 */
	async recordTaskOutcomeFromParsed(task: AgentTask, outcome: TaskOutcome): Promise<TaskOutcome> {
		if (!this.sessionState) return outcome

		for (const f of outcome.filesCreated) {
			if (!this.sessionState.allCreatedFiles.includes(f))
				this.sessionState.allCreatedFiles.push(f)
		}
		for (const f of outcome.filesModified) {
			if (!this.sessionState.allModifiedFiles.includes(f) &&
				!this.sessionState.allCreatedFiles.includes(f))
				this.sessionState.allModifiedFiles.push(f)
		}
		for (const pkg of outcome.packagesInstalled) {
			const exists = this.sessionState.allInstalledPackages
				.some(p => p.manager === pkg.manager && p.name === pkg.name)
			if (!exists) this.sessionState.allInstalledPackages.push(pkg)
		}

		this.sessionState.taskOutcomes.push(outcome)
		this.sessionState.lastUpdated = Date.now()
		await this._saveSessionState()
		return outcome
	}

	private async _saveSessionState(): Promise<void> {
		if (!this.sessionState || !this.sessionStateURI) return
		try {
			const content = JSON.stringify(this.sessionState, null, 2)
			await this._fileService.writeFile(
				this.sessionStateURI,
				VSBuffer.fromString(content)
			)
		} catch { /* non-fatal: session state is in-memory anyway */ }
	}

	async clearMemory(): Promise<void> {
		this.memory = createEmptyMemory()
		await this.save()
	}

	/**
	 * Cleanup: keep all decision/architecture entries,
	 * trim oldest non-decision entries to MAX_NON_DECISION_ENTRIES.
	 * Total entries capped at MAX_ENTRIES.
	 * Trim taskHistory to max 50.
	 */
	private _cleanMemory(): void {
		const decisions = this.memory.entries.filter(e =>
			e.type === 'decision' || e.type === 'architecture'
		)
		const others = this.memory.entries
			.filter(e => e.type !== 'decision' && e.type !== 'architecture')
			.slice(-MAX_NON_DECISION_ENTRIES)

		this.memory.entries = [...decisions, ...others].slice(-MAX_ENTRIES)
		
		if (this.memory.taskHistory && this.memory.taskHistory.length > 50) {
			this.memory.taskHistory = this.memory.taskHistory.slice(-50)
		}
	}
}

registerSingleton(IMemoryStore, MemoryStore, InstantiationType.Eager)
