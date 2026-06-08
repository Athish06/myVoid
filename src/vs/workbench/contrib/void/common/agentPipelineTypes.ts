/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

// ======================== Agent Task & Plan ========================

export type TaskType = 'create' | 'modify' | 'refactor'
export type TaskStatus = 'pending' | 'running' | 'done' | 'failed'

export interface AgentTask {
	id: string
	title: string
	description: string
	targetFiles: string[]
	dependsOn: string[]
	taskType: TaskType
	status: TaskStatus
	result?: string   // summary of what was done
	error?: string    // error message if failed
}

export interface AgentPlan {
	refinedPrompt: string
	projectSummary: string
	techStack: string[]
	tasks: AgentTask[]
	createdAt: number
	lastModified: number
}

// ======================== Memory ========================

export type MemoryEntryType = 'decision' | 'fix' | 'architecture' | 'file_created' | 'bug_found' | 'pattern'

export interface MemoryEntry {
	id: string
	text: string
	type: MemoryEntryType
	taskId: string
	timestamp: number
}

export interface TaskHistoryEntry {
	taskId: string
	title: string
	description: string
	status: TaskStatus
	result?: string
	timestamp: number
}

export interface ProjectMemory {
	projectSummary: string
	techStack: string[]
	entries: MemoryEntry[]
	taskHistory: TaskHistoryEntry[]
	fileIndex: Record<string, string>  // filename → one-line description
	lastUpdated: number
}

// ======================== Pipeline Config ========================

export interface AgentPipelineConfig {
	planningModel: string     // e.g. 'qwen2.5-coder:7b'
	executionModel: string    // e.g. 'qwen2.5-coder:3b'
	maxTokensPlanning: number
	maxTokensPerTask: number
	memoryContextTokens: number
	maxRetriesPerTask: number
	maxTasksPerPlan: number
	maxFilesPerTask: number
}

export const DEFAULT_PIPELINE_CONFIG: AgentPipelineConfig = {
	planningModel: '',       // empty = use whatever Chat model is selected
	executionModel: '',      // empty = use whatever Chat model is selected
	maxTokensPlanning: 2000,
	maxTokensPerTask: 3000,
	memoryContextTokens: 800,
	maxRetriesPerTask: 2,
	maxTasksPerPlan: 10,
	maxFilesPerTask: 3,
}

// ======================== Pipeline State ========================

export type PipelinePhase =
	| 'idle'
	| 'planning'
	| 'plan_review'
	| 'executing'
	| 'awaiting_feedback'
	| 'paused'
	| 'done'

export interface PipelineState {
	phase: PipelinePhase
	currentPlan: AgentPlan | null
	currentTaskIndex: number        // index into plan.tasks of the currently running task
	executionLog: string            // streaming token output for the current task
	error: string | null            // pipeline-level error (not per-task)
	originalPrompt: string          // the raw user prompt before refinement
	pendingQuestion: string | null  // if phase is 'awaiting_feedback'
	feedbackAnswer: string | null   // storing answer briefly if needed
}

export const DEFAULT_PIPELINE_STATE: PipelineState = {
	phase: 'idle',
	currentPlan: null,
	currentTaskIndex: -1,
	executionLog: '',
	error: null,
	originalPrompt: '',
	pendingQuestion: null,
	feedbackAnswer: null,
}

// ======================== Plan Import ========================

export interface PlanImportResult {
	success: boolean
	tasks?: AgentTask[]
	errors?: string[]
}
