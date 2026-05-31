/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js'
import { Emitter, Event } from '../../../../base/common/event.js'
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js'
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js'
import { ILLMMessageService } from '../common/sendLLMMessageService.js'
import { IVoidSettingsService } from '../common/voidSettingsService.js'
import { IConvertToLLMMessageService } from './convertToLLMMessageService.js'
import { IDirectoryStrService } from '../common/directoryStrService.js'
import { IMemoryStore } from '../common/memoryStore.js'
import {
	AgentPlan, AgentTask, DEFAULT_PIPELINE_STATE,
	PipelinePhase, PipelineState,
} from '../common/agentPipelineTypes.js'
import {
	PROMPT_REFINER_SYSTEM, TASK_GENERATOR_SYSTEM, TASK_EXECUTION_SYSTEM,
	buildPromptRefinerUserMessage, buildTaskGeneratorUserMessage,
	buildTaskExecutionPrompt,
	REPLAN_SYSTEM_PROMPT, buildReplanUserMessage,
	
} from '../common/agentPromptTemplates.js'
import { autoSplitOversizedTasks } from '../common/planExportImport.js'
import { ModelSelection, ProviderName } from '../common/voidSettingsTypes.js'

import { IChatThreadService } from './chatThreadServiceInterface.js'


// ======================== Service Interface ========================

export interface IAgentPipelineService {
	readonly _serviceBrand: undefined

	readonly state: PipelineState
	readonly onDidChangePipelineState: Event<void>

	// Entry point: user typed a prompt and pipeline is enabled
	startPipeline(userPrompt: string): Promise<void>

	// Plan review actions
	approvePlan(): Promise<void>
	updatePlan(newPlan: AgentPlan): void

	// Execution control
	pausePipeline(): void
	resumePipeline(): Promise<void>
	cancelPipeline(): void

	// Get the model selection for a given phase
	getPlanningModelSelection(): ModelSelection | null
	getExecutionModelSelection(): ModelSelection | null
}

export const IAgentPipelineService = createDecorator<IAgentPipelineService>('AgentPipelineService')

// ======================== Implementation ========================

class AgentPipelineService extends Disposable implements IAgentPipelineService {
	readonly _serviceBrand: undefined

	private readonly _onDidChangePipelineState = new Emitter<void>()
	readonly onDidChangePipelineState: Event<void> = this._onDidChangePipelineState.event

	state: PipelineState = { ...DEFAULT_PIPELINE_STATE }

	private _abortCurrentLLM: (() => void) | null = null
	private _isPaused = false

	constructor(
		@ILLMMessageService private readonly _llmMessageService: ILLMMessageService,
		@IVoidSettingsService private readonly _settingsService: IVoidSettingsService,
		@IConvertToLLMMessageService private readonly _convertToLLMMessagesService: IConvertToLLMMessageService,
		@IDirectoryStrService private readonly _directoryStrService: IDirectoryStrService,
		
		@IMemoryStore private readonly _memoryStore: IMemoryStore,
		@IChatThreadService private readonly _chatThreadService: IChatThreadService,
	) {
		super()
	}

	// ======================== State Management ========================

	private _setState(update: Partial<PipelineState>): void {
		this.state = { ...this.state, ...update }
		this._onDidChangePipelineState.fire()
	}

	private _setPhase(phase: PipelinePhase): void {
		this._setState({ phase })
	}

	// ======================== Model Selection ========================

	/**
	 * Returns the ModelSelection for the planning phase.
	 * If an override is set, parse it as providerName + modelName from the Ollama-style string.
	 * Otherwise fall back to the Chat model.
	 */
	getPlanningModelSelection(): ModelSelection | null {
		const override = this._settingsService.state.globalSettings.agentPlanningModelOverride
		if (override) {
			return this._parseOllamaModelToSelection(override)
		}
		return this._settingsService.state.modelSelectionOfFeature['Chat']
	}

	getExecutionModelSelection(): ModelSelection | null {
		const override = this._settingsService.state.globalSettings.agentExecutionModelOverride
		if (override) {
			return this._parseOllamaModelToSelection(override)
		}
		return this._settingsService.state.modelSelectionOfFeature['Chat']
	}

	/**
	 * Converts an Ollama-style model name (e.g. 'qwen2.5-coder:7b') to a ModelSelection.
	 * Checks if the model exists in the current Ollama models list.
	 */
	private _parseOllamaModelToSelection(modelStr: string): ModelSelection | null {
		if (!modelStr) return null

		// Check Ollama first (most common for local models)
		const ollamaModels = this._settingsService.state.settingsOfProvider.ollama.models
		const found = ollamaModels.find(m => m.modelName === modelStr)
		if (found) {
			return { providerName: 'ollama' as ProviderName, modelName: modelStr }
		}

		// Fall back to whatever Chat is set to
		return this._settingsService.state.modelSelectionOfFeature['Chat']
	}

	// ======================== Pipeline Entry Point ========================

	async startPipeline(userPrompt: string): Promise<void> {
		// Load memory at the start
		await this._memoryStore.load()

		this._setState({
			...DEFAULT_PIPELINE_STATE,
			phase: 'planning',
			originalPrompt: userPrompt,
		})

		try {
			await this._runPlanningPhase(userPrompt)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			this._setState({ phase: 'idle', error: `Planning failed: ${message}` })
		}
	}

	// ======================== Phase 1: Planning ========================

	private async _runPlanningPhase(userPrompt: string): Promise<void> {
		const modelSelection = this.getPlanningModelSelection()
		if (!modelSelection) {
			this._setState({ phase: 'idle', error: 'No model selected. Please configure a model in Void Settings.' })
			return
		}

		// Get workspace context for prompt refinement
		const directoryStr = await this._directoryStrService.getAllDirectoriesStr({
			cutOffMessage: '...Directories cut off, use tools to read more...'
		})

		// Step 1: Refine the prompt
		this._setState({ executionLog: 'Refining your prompt...' })
		const refinedResult = await this._callLLMForJSON(
			PROMPT_REFINER_SYSTEM,
			buildPromptRefinerUserMessage(userPrompt, directoryStr),
			modelSelection,
		)

		if (!refinedResult) {
			this._setState({ phase: 'idle', error: 'Failed to refine prompt. Model did not return valid JSON.' })
			return
		}

		let refinedPrompt: string
		let projectSummary: string
		let techStack: string[]
		try {
			const parsed = JSON.parse(refinedResult)
			refinedPrompt = parsed.refinedPrompt || userPrompt
			projectSummary = parsed.projectSummary || ''
			techStack = Array.isArray(parsed.techStack) ? parsed.techStack : []
		} catch {
			// If JSON parsing fails, use the raw prompt as-is
			refinedPrompt = userPrompt
			projectSummary = ''
			techStack = []
		}

		// Update memory with project info
		await this._memoryStore.updateProjectInfo(projectSummary, techStack)

		// Step 2: Generate task list
		this._setState({ executionLog: 'Generating task list...' })
		const taskResult = await this._callLLMForJSON(
			TASK_GENERATOR_SYSTEM,
			buildTaskGeneratorUserMessage(refinedPrompt, projectSummary, techStack, directoryStr),
			modelSelection,
		)

		if (!taskResult) {
			this._setState({ phase: 'idle', error: 'Failed to generate tasks. Model did not return valid JSON.' })
			return
		}

		let tasks: AgentTask[]
		try {
			const parsed = JSON.parse(taskResult)
			const rawTasks: AgentTask[] = (parsed.tasks || []).map((t: Record<string, unknown>, i: number) => ({
				id: (t.id as string) || `task_${String(i + 1).padStart(3, '0')}`,
				title: (t.title as string) || `Task ${i + 1}`,
				description: (t.description as string) || '',
				targetFiles: Array.isArray(t.targetFiles) ? t.targetFiles as string[] : [],
				dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn as string[] : [],
				taskType: (t.taskType === 'create' || t.taskType === 'modify' || t.taskType === 'refactor') ? t.taskType : 'modify',
				status: 'pending' as const,
			}))
			tasks = autoSplitOversizedTasks(rawTasks)
		} catch {
			this._setState({ phase: 'idle', error: 'Failed to parse task list from model output.' })
			return
		}

		// Build the plan
		const plan: AgentPlan = {
			refinedPrompt,
			projectSummary,
			techStack,
			tasks,
			createdAt: Date.now(),
			lastModified: Date.now(),
		}

		this._setState({
			phase: 'plan_review',
			currentPlan: plan,
			executionLog: '',
		})
	}

	// ======================== Plan Review ========================

	updatePlan(newPlan: AgentPlan): void {
		this._setState({
			currentPlan: { ...newPlan, lastModified: Date.now() },
		})
	}

	async approvePlan(): Promise<void> {
		if (!this.state.currentPlan || this.state.phase !== 'plan_review') return
		this._setState({ phase: 'executing', currentTaskIndex: 0, executionLog: '' })
		this._isPaused = false

		try {
			await this._runExecutionPhase()
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			this._setState({ error: `Execution error: ${message}` })
		}
	}

	// ======================== Phase 2: Execution ========================

	private async _runExecutionPhase(): Promise<void> {
		const plan = this.state.currentPlan
		if (!plan) return

		const modelSelection = this.getExecutionModelSelection()
		if (!modelSelection) {
			this._setState({ phase: 'paused', error: 'No execution model selected.' })
			return
		}

		const failureCountOfTaskId = new Map<string, number>()

		for (let i = 0; i < plan.tasks.length; i++) {
			if (this._isPaused) {
				this._setState({ phase: 'paused', currentTaskIndex: i })
				return
			}

			const task = plan.tasks[i]
			if (task.status === 'done') continue // already completed (e.g. resumed after pause)

			// Check dependencies
			const depsOk = task.dependsOn.every(depId => {
				const dep = plan.tasks.find(t => t.id === depId)
				return dep && dep.status === 'done'
			})
			if (!depsOk) {
				task.status = 'failed'
				task.error = 'Dependencies not met'
				this._updatePlanTasks(plan)
				continue
			}

			// Mark running
			task.status = 'running'
			this._setState({ currentTaskIndex: i, executionLog: '' })
			this._updatePlanTasks(plan)

			// Build context with memory
			const memoryContext = this._memoryStore.buildContextString(task)
			const executionPrompt = buildTaskExecutionPrompt(task, plan, memoryContext)

			// Execute the task by sending to the chat thread service as a user message
			// The task execution goes through the existing agent tool loop
			try {
				const threadId = this._chatThreadService.state.currentThreadId
				await this._chatThreadService.addUserMessageAndStreamResponse({
					userMessage: `${TASK_EXECUTION_SYSTEM}\n\n${executionPrompt}`,
					threadId,
				})

				// Wait for the stream to finish
				await this._waitForStreamComplete(threadId)

				// Mark done
				task.status = 'done'
				task.result = `Completed: ${task.title}`
				this._updatePlanTasks(plan)

				// Extract and store memory
				await this._extractMemory(task, task.result)

			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error)
				const attempts = (failureCountOfTaskId.get(task.id) ?? 0) + 1
				failureCountOfTaskId.set(task.id, attempts)

				if (attempts >= 2) {
					// Re-plan this task
					task.status = 'failed'
					task.error = errorMsg
					this._updatePlanTasks(plan)

					try {
						await this._handleReplan(task, plan, errorMsg, modelSelection)
					} catch {
						// Re-planning also failed, continue with remaining tasks
					}
				} else {
					// First failure: retry
					task.status = 'pending'
					this._updatePlanTasks(plan)
					i-- // retry same index
				}
			}
		}

		this._setPhase('done')
	}

	/**
	 * Wait for the current thread's stream to complete.
	 * Polls the stream state until it's no longer running.
	 */
	private _waitForStreamComplete(threadId: string): Promise<void> {
		return new Promise<void>((resolve) => {
			const check = () => {
				const streamState = this._chatThreadService.streamState[threadId]
				if (!streamState?.isRunning) {
					resolve()
					return
				}
				setTimeout(check, 500)
			}
			// Start checking after a short delay to let the stream begin
			setTimeout(check, 1000)
		})
	}

	// ======================== Re-Planning ========================

	private async _handleReplan(
		failedTask: AgentTask,
		plan: AgentPlan,
		lastError: string,
		modelSelection: ModelSelection,
	): Promise<void> {
		const affectedTasks = this._getTaskAndDependents(failedTask.id, plan.tasks)

		const result = await this._callLLMForJSON(
			REPLAN_SYSTEM_PROMPT,
			buildReplanUserMessage(failedTask, lastError, {}, affectedTasks),
			modelSelection,
		)

		if (!result) return

		try {
			const parsed = JSON.parse(result)
			const replacements: AgentTask[] = (parsed.replacementTasks || []).map((t: Record<string, unknown>) => ({
				id: (t.id as string) || `${failedTask.id}_retry`,
				title: (t.title as string) || failedTask.title,
				description: (t.description as string) || failedTask.description,
				targetFiles: Array.isArray(t.targetFiles) ? t.targetFiles as string[] : failedTask.targetFiles,
				dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn as string[] : [],
				taskType: 'modify' as const,
				status: 'pending' as const,
			}))

			if (replacements.length > 0) {
				// Replace the failed task and its dependents with new tasks
				const failedIdx = plan.tasks.indexOf(failedTask)
				const affectedIds = new Set(affectedTasks.map(t => t.id))
				affectedIds.add(failedTask.id)

				const kept = plan.tasks.filter(t => !affectedIds.has(t.id))
				plan.tasks = [...kept.slice(0, failedIdx), ...replacements, ...kept.slice(failedIdx)]
				this._updatePlanTasks(plan)
			}
		} catch {
			// Re-plan parsing failed, skip
		}
	}

	private _getTaskAndDependents(taskId: string, tasks: AgentTask[]): AgentTask[] {
		const result: AgentTask[] = []
		const visited = new Set<string>()

		const collect = (id: string) => {
			if (visited.has(id)) return
			visited.add(id)
			for (const t of tasks) {
				if (t.dependsOn.includes(id)) {
					result.push(t)
					collect(t.id)
				}
			}
		}
		collect(taskId)
		return result
	}

	// ======================== Memory Extraction ========================

	private async _extractMemory(task: AgentTask, taskResult: string): Promise<void> {
		// Simple memory: just record what was done without calling LLM
		// (LLM-based extraction is expensive for small models; do it simply)
		await this._memoryStore.addEntry({
			text: `${task.title}: ${task.description.slice(0, 100)}`,
			type: task.taskType === 'create' ? 'file_created' : 'fix',
			taskId: task.id,
		})

		// Update file index for files that were touched
		const fileUpdates: Record<string, string> = {}
		for (const f of task.targetFiles) {
			fileUpdates[f] = task.title
		}
		await this._memoryStore.updateFileIndex(fileUpdates)
	}

	// ======================== Execution Control ========================

	pausePipeline(): void {
		this._isPaused = true
		this._setPhase('paused')
		if (this._abortCurrentLLM) {
			this._abortCurrentLLM()
			this._abortCurrentLLM = null
		}
	}

	async resumePipeline(): Promise<void> {
		if (this.state.phase !== 'paused' || !this.state.currentPlan) return
		this._isPaused = false
		this._setPhase('executing')
		try {
			await this._runExecutionPhase()
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			this._setState({ error: `Execution error: ${message}` })
		}
	}

	cancelPipeline(): void {
		this._isPaused = true
		if (this._abortCurrentLLM) {
			this._abortCurrentLLM()
			this._abortCurrentLLM = null
		}
		this._setState({ ...DEFAULT_PIPELINE_STATE })
	}

	// ======================== LLM Helpers ========================

	/**
	 * Sends a prompt to the LLM and returns the full response text.
	 * Used for planning calls that expect JSON responses (not tool calls).
	 */
	private _callLLMForJSON(
		systemPrompt: string,
		userMessage: string,
		modelSelection: ModelSelection,
	): Promise<string | null> {

		return new Promise<string | null>((resolve) => {
			const { overridesOfModel } = this._settingsService.state

			// Prepare messages: system + user, no tools
			const { messages, separateSystemMessage } = this._convertToLLMMessagesService.prepareLLMSimpleMessages({
				simpleMessages: [
					{ role: 'user', content: `${systemPrompt}\n\n${userMessage}` }
				],
				systemMessage: systemPrompt,
				modelSelection,
				featureName: 'Chat',
			})

			const requestId = this._llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				chatMode: null, // no tools for planning calls
				messages,
				modelSelection,
				modelSelectionOptions: undefined,
				overridesOfModel,
				logging: { loggingName: 'Agent Pipeline - Planning' },
				separateSystemMessage,
				onText: ({ fullText }) => {
					// Update the execution log with streaming output
					this._setState({ executionLog: fullText })
				},
				onFinalMessage: ({ fullText }) => {
					this._abortCurrentLLM = null
					// Try to extract JSON from the response
					const json = this._extractJSON(fullText)
					resolve(json)
				},
				onError: () => {
					this._abortCurrentLLM = null
					resolve(null)
				},
				onAbort: () => {
					this._abortCurrentLLM = null
					resolve(null)
				},
			})

			if (requestId) {
				this._abortCurrentLLM = () => this._llmMessageService.abort(requestId)
			} else {
				resolve(null)
			}
		})
	}

	/**
	 * Extracts JSON from an LLM response that might include markdown fences or extra text.
	 */
	private _extractJSON(text: string): string | null {
		// Try direct parse first
		try {
			JSON.parse(text.trim())
			return text.trim()
		} catch { /* continue */ }

		// Try extracting from markdown fences
		const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
		if (fenceMatch) {
			try {
				JSON.parse(fenceMatch[1].trim())
				return fenceMatch[1].trim()
			} catch { /* continue */ }
		}

		// Try finding first { to last }
		const firstBrace = text.indexOf('{')
		const lastBrace = text.lastIndexOf('}')
		if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
			const candidate = text.slice(firstBrace, lastBrace + 1)
			try {
				JSON.parse(candidate)
				return candidate
			} catch { /* give up */ }
		}

		return null
	}

	// ======================== Helpers ========================

	private _updatePlanTasks(plan: AgentPlan): void {
		this._setState({ currentPlan: { ...plan, lastModified: Date.now() } })
	}
}

registerSingleton(IAgentPipelineService, AgentPipelineService, InstantiationType.Eager)
