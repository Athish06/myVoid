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
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js'
import { IMemoryStore } from '../common/memoryStore.js'
import {
	AgentPlan, AgentTask, DEFAULT_PIPELINE_STATE,
	PipelinePhase, PipelineState,
} from '../common/agentPipelineTypes.js'
import {
	PROMPT_REFINER_SYSTEM, TASK_GENERATOR_SYSTEM,
	buildPromptRefinerUserMessage, buildTaskGeneratorUserMessage,
	buildTaskExecutionPrompt, AUTONOMOUS_EXECUTION_SYSTEM_PROMPT,
	REPLAN_SYSTEM_PROMPT, buildReplanUserMessage,
	AUTONOMOUS_CONTINUATION_PROMPT, AUTONOMOUS_EXECUTION_SYSTEM_PROMPT_7B,
} from '../common/agentPromptTemplates.js'
import { autoSplitOversizedTasks } from '../common/planExportImport.js'
import { ModelSelection, ProviderName } from '../common/voidSettingsTypes.js'
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js'

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

	// Feedback loop
	submitFeedback(answer: string): Promise<void>

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
	private _lastLLMError: string | null = null

	constructor(
		@ILLMMessageService private readonly _llmMessageService: ILLMMessageService,
		@IVoidSettingsService private readonly _settingsService: IVoidSettingsService,
		@IConvertToLLMMessageService private readonly _convertToLLMMessagesService: IConvertToLLMMessageService,
		@IDirectoryStrService private readonly _directoryStrService: IDirectoryStrService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		
		@IMemoryStore private readonly _memoryStore: IMemoryStore,
		@IChatThreadService private readonly _chatThreadService: IChatThreadService,
		@IDialogService private readonly _dialogService: IDialogService,
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

		// Fall back to whatever Chat is set to, but warn the user
		this._setState({ error: `Warning: Override model '${modelStr}' not found in Ollama list. Falling back to Chat model.` })
		return this._settingsService.state.modelSelectionOfFeature['Chat']
	}

	// ======================== Pipeline Entry Point ========================

	async startPipeline(userPrompt: string): Promise<void> {
		let clearOldPlan = true

		if (this.state.currentPlan && this.state.currentPlan.tasks.length > 0) {
			const hasPendingTasks = this.state.currentPlan.tasks.some(t => t.status !== 'done')
			if (hasPendingTasks) {
				const res = await this._dialogService.prompt<'add' | 'clear' | 'cancel'>({
					type: 'question',
					message: 'You have unfinished tasks from a previous prompt.',
					detail: 'Would you like to add the current task to the previous plan, or clear old tasks?',
					buttons: [
						{ label: 'Add to old plan', run: () => 'add' },
						{ label: 'Clear old plan', run: () => 'clear' }
					],
					cancelButton: { label: 'Cancel', run: () => 'cancel' }
				})

				if (res.result === 'cancel' || res.result === undefined) {
					return
				}
				clearOldPlan = res.result === 'clear'
			}
		}

		if (clearOldPlan && this.state.currentPlan && this.state.currentPlan.tasks.length > 0) {
			await this._memoryStore.archiveCompletedTasks(this.state.currentPlan.tasks)
		}

		// Load memory at the start
		await this._memoryStore.load()

		// Initialize session state (deterministic, resets per pipeline run)
		const workspaceFolders_ = this._workspaceContextService?.getWorkspace?.()?.folders || []
		const workspaceRoot_ = workspaceFolders_.length > 0 ? workspaceFolders_[0].uri.fsPath : ''
		await this._memoryStore.startSession(workspaceRoot_)

		if (clearOldPlan) {
			this._setState({
				...DEFAULT_PIPELINE_STATE,
				phase: 'planning',
				originalPrompt: userPrompt,
			})
		} else {
			this._setState({
				phase: 'planning',
				originalPrompt: this.state.originalPrompt + '\n\nAdditional Request: ' + userPrompt,
			})
		}

		try {
			const forceplan = this._settingsService.state.globalSettings.agentForceExecutionPlan
			if (forceplan === true || forceplan === 'my_plan') {
				await this._runPlanningPhase(this.state.originalPrompt, !clearOldPlan, forceplan === 'my_plan')
			} else {
				// Plan is OFF — skip planning, create single-task plan and execute directly
				const directoryStr = await this._directoryStrService.getAllDirectoriesStr({
					cutOffMessage: '...cut off...'
				})
				const workspaceFolders = this._workspaceContextService?.getWorkspace?.()?.folders || []
				const workspaceRoot = workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : ''

				const richDescription = `${userPrompt}\n\nWORKSPACE ROOT: ${workspaceRoot}\n\nFILE STRUCTURE:\n${directoryStr.slice(0, 1500)}\n\nIMPORTANT: You MUST use the available XML tools (<read_file>, <rewrite_file>, <edit_file>, <run_command>, <ls_dir>, etc.) to complete this task. Do NOT just describe what to do — actually execute it using XML tool calls. Start by exploring the relevant files using <ls_dir> or <get_dir_tree> if needed. Do NOT type these tool names into the terminal.`

				const plan: AgentPlan = {
					refinedPrompt: userPrompt,
					projectSummary: '',
					techStack: [],
					tasks: [{
						id: 'task_001',
						title: userPrompt.slice(0, 80),
						description: richDescription,
						targetFiles: [],
						dependsOn: [],
						taskType: 'modify',
						status: 'pending',
					}],
					createdAt: Date.now(),
					lastModified: Date.now(),
				}
				this._setState({
					currentPlan: plan,
					phase: 'executing',
					currentTaskIndex: 0,
					executionLog: 'Planning bypassed, executing directly...',
				})
				await this._runExecutionPhase()
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			this._setState({ phase: 'idle', error: `Planning failed: ${message}` })
		}
	}

	// ======================== Phase 1: Planning ========================

	private async _runPlanningPhase(userPrompt: string, isAppending: boolean = false, isMyPlan: boolean = false): Promise<void> {
		const modelSelection = this.getPlanningModelSelection()
		if (!modelSelection) {
			this._setState({ phase: 'idle', error: 'No model selected. Please configure a model in Void Settings.' })
			return
		}

		this._chatThreadService.setPipelinePlanningRunning(this._chatThreadService.state.currentThreadId, true)

		try {
			// Get workspace context for prompt refinement
			const directoryStr = await this._directoryStrService.getAllDirectoriesStr({
				cutOffMessage: '...Directories cut off, use tools to read more...'
			})

		// Split userPrompt into instructions and selections (if any)
		// The UI appends file contents using "\n---\nSELECTIONS\n"
		let instructions = userPrompt
		let selectionsStr = ''
		const sepMatch = userPrompt.match(/\n---\nSELECTIONS\n/i)
		if (sepMatch && sepMatch.index !== undefined) {
			instructions = userPrompt.substring(0, sepMatch.index)
			selectionsStr = userPrompt.substring(sepMatch.index)
		}

		// Step 1: Refine the prompt (non-fatal — if it fails, use raw prompt)
		this._setState({ executionLog: 'Refining your prompt...' })
		let refinedPrompt: string = userPrompt
		let projectSummary: string = ''
		let techStack: string[] = []

		const refinedResult = await this._callLLMForJSON(
			PROMPT_REFINER_SYSTEM,
			buildPromptRefinerUserMessage(instructions, directoryStr),
			modelSelection,
		)

		if (refinedResult) {
			try {
				const parsed = JSON.parse(refinedResult)
				// Re-attach the selections to the refined instructions
				refinedPrompt = (parsed.refinedPrompt || instructions) + selectionsStr
				projectSummary = parsed.projectSummary || ''
				techStack = Array.isArray(parsed.techStack) ? parsed.techStack : []
			} catch {
				// JSON parsing failed, use raw prompt
				this._setState({ executionLog: 'Prompt refinement returned non-JSON, using your original prompt...' })
			}
		} else {
			// LLM call failed or returned null — continue with raw prompt
			this._setState({ executionLog: `Prompt refinement failed (${this._lastLLMError || 'unknown error'}), using your original prompt...` })
		}

		// Update memory with project info
		const memory = this._memoryStore.getMemory()
		const newProjectSummary = projectSummary || memory.projectSummary
		const newTechStack = Array.from(new Set([...(memory.techStack || []), ...techStack]))
		await this._memoryStore.updateProjectInfo(newProjectSummary, newTechStack)

		const existingTasks = isAppending && this.state.currentPlan ? this.state.currentPlan.tasks : []
		const existingTasksStr = existingTasks.map((t, i) => `${i + 1}. [${t.status}] ${t.title} - ${t.description}`).join('\n')
		
		const taskHistory = this._memoryStore.getTaskHistory()
		const taskHistoryStr = taskHistory.map((t, i) => `${i + 1}. [${t.status}] ${t.title}${t.result ? ` - ${t.result}` : ''}`).join('\n')
		let tasks: AgentTask[]

		// Helper to build rich fallback description
		const workspaceFolders = this._workspaceContextService?.getWorkspace?.()?.folders || []
		const workspaceRoot = workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : ''
		const richFallbackDescription = `${refinedPrompt}\n\nWORKSPACE ROOT: ${workspaceRoot}\n\nFILE STRUCTURE:\n${directoryStr.slice(0, 1500)}\n\nIMPORTANT: You MUST use the available XML tools (<read_file>, <rewrite_file>, <edit_file>, <run_command>, <ls_dir>, etc.) to complete this task. Do NOT just describe what to do — actually execute it using XML tool calls. Start by exploring the relevant files using <ls_dir> or <get_dir_tree> if needed. Do NOT type these tool names into the terminal.`

		if (isMyPlan) {
			this._setState({ executionLog: 'Ready for you to paste or edit your execution plan.' })
			tasks = [{
				id: 'task_001',
				title: 'Manual Task (Edit me)',
				description: richFallbackDescription,
				targetFiles: [],
				dependsOn: [],
				taskType: 'modify',
				status: 'pending',
			}]
		} else {
			// Step 2: Generate task list
			this._setState({ executionLog: 'Generating task list...' })
			const taskResult = await this._callLLMForJSON(
				TASK_GENERATOR_SYSTEM,
				buildTaskGeneratorUserMessage(refinedPrompt, newProjectSummary, newTechStack, directoryStr, existingTasksStr, taskHistoryStr),
				modelSelection,
			)

			if (!taskResult) {
				// Task generation failed — create a single fallback task with the user's prompt
				this._setState({ executionLog: `Task generation failed (${this._lastLLMError || 'unknown error'}), creating single task from your prompt...` })
				tasks = [{
					id: 'task_001',
					title: refinedPrompt.slice(0, 80),
					description: richFallbackDescription,
					targetFiles: [],
					dependsOn: [],
					taskType: 'modify',
					status: 'pending',
				}]
			} else {
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
					// Parsing failed — create single task fallback
					tasks = [{
						id: 'task_001',
						title: refinedPrompt.slice(0, 80),
						description: richFallbackDescription,
						targetFiles: [],
						dependsOn: [],
						taskType: 'modify',
						status: 'pending',
					}]
				}
			}
		}

		// Build the plan
		const plan: AgentPlan = {
			refinedPrompt,
			projectSummary,
			techStack,
			tasks: [...existingTasks, ...tasks],
			createdAt: Date.now(),
			lastModified: Date.now(),
		}

		this._setState({
			phase: 'plan_review',
			currentPlan: plan,
			executionLog: '',
		})

		} finally {
			this._chatThreadService.setPipelinePlanningRunning(this._chatThreadService.state.currentThreadId, false)
		}
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
		if (!this.state.currentPlan) return
		let plan: AgentPlan = this.state.currentPlan

		const modelSelection = this.getExecutionModelSelection()
		if (!modelSelection) {
			this._setState({ phase: 'paused', error: 'No execution model selected.' })
			return
		}

		const failureCountOfTaskId = new Map<string, number>()
		let totalReplanAttempts = 0

		this._chatThreadService.setChatModeOverride('agent')
		this._chatThreadService.setPipelineAutoApprove(true)

		try {
			// Use a while loop because we may restart execution after replanning
			while (true) {
			if (this._isPaused) {
				const currentIdx = plan.tasks.findIndex(t => t.status === 'pending' || t.status === 'running')
				this._setState({ phase: 'paused', currentTaskIndex: Math.max(0, currentIdx) })
				return
			}

			// Find the first task that needs to be executed
			const taskIndex = plan.tasks.findIndex(t => t.status === 'pending' || t.status === 'running')
			if (taskIndex === -1) {
				// All tasks done or failed
				break
			}

			const task = plan.tasks[taskIndex]

			// Check dependencies
			const depsOk = task.dependsOn.every((depId: string) => {
				const dep = plan.tasks.find(t => t.id === depId)
				return dep && dep.status === 'done'
			})
			if (!depsOk) {
				plan = {
					...plan,
					tasks: plan.tasks.map((t: AgentTask): AgentTask => t.id === task.id ? { ...t, status: 'failed', error: 'Dependencies not met' } : t)
				}
				this._updatePlanTasks(plan)
				continue
			}

			// Mark running
			plan = {
				...plan,
				tasks: plan.tasks.map((t: AgentTask): AgentTask => t.id === task.id ? { ...t, status: 'running' } : t)
			}
			this._setState({ currentTaskIndex: taskIndex, executionLog: '' })
			this._updatePlanTasks(plan)

			// Build context with memory + session state
			const memoryContext = this._memoryStore.buildContextString(task, 350)
			const sessionContextBlock = this._memoryStore.buildSessionContextBlock()
			const executionPrompt = buildTaskExecutionPrompt(task, plan, memoryContext, sessionContextBlock)

			// Get the workspace root
			const workspaceFolders = this._workspaceContextService?.getWorkspace?.()?.folders || []
			const workspaceRootMsg = workspaceFolders.length > 0 
				? `Your root workspace directory is: ${workspaceFolders[0].uri.fsPath}\nUse this as the cwd for all terminal commands unless instructed otherwise.` 
				: 'No workspace folder is open.'

			// Detect model size for prompt selection
			const modelName = (modelSelection?.modelName || '').toLowerCase()
			const isSmallModel = /7b|8b|3b|1b|:7b|:8b|:3b|:1b/.test(modelName)

			// First task gets the full system prompt (7B or standard).
			// Subsequent tasks get a compact continuation to avoid attention dilution.
			const isFirstTask = plan.tasks.filter(t => t.status === 'done').length === 0

			const systemPromptToUse = isSmallModel
				? AUTONOMOUS_EXECUTION_SYSTEM_PROMPT_7B
				: AUTONOMOUS_EXECUTION_SYSTEM_PROMPT

			const preamble = isFirstTask
				? `${systemPromptToUse}\n\n${workspaceRootMsg}`
				: `${AUTONOMOUS_CONTINUATION_PROMPT}\n\n${workspaceRootMsg}`

			// Execute the task by sending to the chat thread service as a user message
			try {
				const threadId = this._chatThreadService.state.currentThreadId
				
				if (this.state.feedbackAnswer !== null) {
					const answer = this.state.feedbackAnswer
					this._setState({ feedbackAnswer: null })
					await this._chatThreadService.addUserMessageAndStreamResponse({
						userMessage: `USER FEEDBACK:\n${answer}\n\nPlease proceed with the task.`,
						threadId,
					})
				} else {
					await this._chatThreadService.addUserMessageAndStreamResponse({
						userMessage: `__PIPELINE_HIDDEN__\n${preamble}\n\n${executionPrompt}`,
						threadId,
					})
				}

				await this._waitForStreamComplete(threadId)

				if (this._isPaused && this.state.phase !== 'awaiting_feedback') {
					plan = {
						...plan,
						tasks: plan.tasks.map((t: AgentTask): AgentTask => t.id === task.id ? { ...t, status: 'pending' } : t)
					}
					this._updatePlanTasks(plan)
					break
				}

				// Check if the agent asked a question
				const thread = this._chatThreadService.state.allThreads[threadId]
				const lastMsg = [...(thread?.messages || [])].reverse().find(m => m.role === 'assistant')
				if (lastMsg && /AGENT_QUESTION:/i.test(lastMsg.displayContent || '')) {
					const questionMatch = lastMsg.displayContent!.match(/AGENT_QUESTION:\s*(.*)/i)
					if (questionMatch) {
						this._setState({ 
							phase: 'awaiting_feedback', 
							pendingQuestion: questionMatch[1].trim(),
							currentTaskIndex: taskIndex 
						})
						this._isPaused = true
						return // Pause and wait for user to call submitFeedback
					}
				}

				// Mark done
				plan = {
					...plan,
					tasks: plan.tasks.map((t: AgentTask): AgentTask => t.id === task.id ? { ...t, status: 'done', result: `Completed: ${task.title}` } : t)
				}
				this._updatePlanTasks(plan)

				let recentLog = `Completed: ${task.title}`;
				if (thread && thread.messages) {
					recentLog = JSON.stringify(thread.messages.slice(-5));
				}

				// Extract and store memory (deterministic + async LLM for decisions)
				await this._extractMemory(task, recentLog, threadId)

			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error)
				const attempts = (failureCountOfTaskId.get(task.id) ?? 0) + 1
				failureCountOfTaskId.set(task.id, attempts)

				if (attempts >= 2) {
					if (totalReplanAttempts >= 3) {
						plan = {
							...plan,
							tasks: plan.tasks.map((t: AgentTask): AgentTask => t.id === task.id ? { ...t, status: 'failed', error: `Failed after max replans: ${errorMsg}` } : t)
						}
						this._updatePlanTasks(plan)
						continue // skip replanning, just fail the task
					}

					// Re-plan this task
					plan = {
						...plan,
						tasks: plan.tasks.map((t: AgentTask): AgentTask => t.id === task.id ? { ...t, status: 'failed', error: errorMsg } : t)
					}
					this._updatePlanTasks(plan)

					totalReplanAttempts++
					try {
						// _handleReplan will mutate plan.tasks. We must ensure it's immutable there too, or we can just pull it from state afterwards.
						await this._handleReplan(task, plan, errorMsg, modelSelection)
						plan = this.state.currentPlan! // update local reference to the new plan
						// Restart loop to find the next pending task
						continue
					} catch {
						// Re-planning also failed, continue with remaining tasks
					}
				} else {
					// First failure: retry
					plan = {
						...plan,
						tasks: plan.tasks.map((t: AgentTask): AgentTask => t.id === task.id ? { ...t, status: 'pending' } : t)
					}
					this._updatePlanTasks(plan)
					// loop will retry the same task since it's the first pending
				}
			}
		} // end while(true)
		} finally {
			this._chatThreadService.setChatModeOverride(null)
			this._chatThreadService.setPipelineAutoApprove(false)
		}

		if (!this._isPaused) {
			this._setPhase('done')
		}
	}

	/**
	 * Wait for the current thread's stream to complete.
	 * Polls the stream state until it's no longer running.
	 * Handles race conditions where the stream may already be running or already finished.
	 */
	private _waitForStreamComplete(threadId: string): Promise<void> {
		return new Promise<void>((resolve) => {
			// Check if stream is already running right now
			const currentState = this._chatThreadService.streamState[threadId]
			let streamStarted = currentState?.isRunning !== undefined

			// If stream is not even started yet and not running, give it a moment to start
			const disposable = this._chatThreadService.onDidChangeStreamState(({ threadId: id }) => {
				if (id !== threadId) return
				const state = this._chatThreadService.streamState[threadId]

				if (!streamStarted && state?.isRunning !== undefined) {
					streamStarted = true // stream confirmed started
					return
				}
				if (streamStarted && state?.isRunning === undefined) {
					disposable.dispose()
					resolve()
				}
			})

			// Safety: if stream already finished before listener was attached
			if (streamStarted && currentState?.isRunning === undefined) {
				disposable.dispose()
				resolve()
				return
			}

			// Timeout fallback: max 5 minutes per task to prevent infinite hang
			setTimeout(() => {
				disposable.dispose()
				resolve()
			}, 5 * 60 * 1000)
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
				const newTasks = [...kept.slice(0, failedIdx), ...replacements, ...kept.slice(failedIdx)]
				this._updatePlanTasks({ ...plan, tasks: newTasks })
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

	/**
	 * Deterministic memory extraction from tool calls + fire-and-forget async LLM for architectural decisions.
	 * The deterministic parser handles all "what" facts (files, packages).
	 * The async LLM only handles "why" decisions (non-blocking, never delays next task).
	 */
	private async _extractMemory(task: AgentTask, _taskResult: string, threadId: string): Promise<void> {
		// Step A: Deterministic extraction from tool calls in the agent's messages
		const thread = this._chatThreadService.state.allThreads[threadId]
		const recentMessages = thread?.messages?.slice(-12) || []

		// Concatenate all assistant output from this task's messages
		const agentOutputText = recentMessages
			.filter(m => m.role === 'assistant')
			.map(m => m.displayContent || '')
			.join('\n')

		// This is deterministic — no LLM call, no summarisation errors
		const outcome = await this._memoryStore.recordTaskOutcome(task, agentOutputText)

		// Step B: Update the file index in long-term memory
		const fileUpdates: Record<string, string> = {}
		for (const f of [...outcome.filesCreated, ...outcome.filesModified]) {
			fileUpdates[f] = task.title
		}
		if (Object.keys(fileUpdates).length > 0) {
			await this._memoryStore.updateFileIndex(fileUpdates)
		}

		// Step C: Add a compact entry to long-term memory store
		if (outcome.summary) {
			await this._memoryStore.addEntry({
				text: outcome.summary,
				type: task.taskType === 'create' ? 'file_created' : 'fix',
				taskId: task.id,
			})
		}

		// Step D: Fire-and-forget async LLM for architectural decisions only.
		// Non-blocking — never delays the next task.
		const modelSelection = this.getPlanningModelSelection()
		if (modelSelection && outcome.filesCreated.length > 0) {
			this._callLLMForJSON(
				`You detect architectural decisions from coding tasks.
Output ONLY valid JSON: { "decision": "one sentence about any important design choice, or null if none" }
Only extract a decision if there was a genuinely important architectural choice (framework, pattern, schema design).
Do NOT describe what files were created — the file list is already tracked elsewhere.`,
				`TASK: ${task.title}\nFILES CREATED: ${outcome.filesCreated.join(', ')}\nSUMMARY: ${outcome.summary}`,
				modelSelection,
			).then(result => {
				if (!result) return
				try {
					const parsed = JSON.parse(result)
					if (parsed.decision && typeof parsed.decision === 'string') {
						this._memoryStore.addEntry({
							text: parsed.decision,
							type: 'decision',
							taskId: task.id,
						})
					}
				} catch { /* non-fatal */ }
			})
		}
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

	async submitFeedback(answer: string): Promise<void> {
		if (this.state.phase !== 'awaiting_feedback' || !this.state.currentPlan) return
		this._setState({ feedbackAnswer: answer, phase: 'executing', pendingQuestion: null })
		this._isPaused = false
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
					{ role: 'user', content: userMessage }
				],
				systemMessage: systemPrompt,
				modelSelection,
				featureName: 'Chat', // Fallback to Chat settings for the model options
			})

			const requestId = this._llmMessageService.sendLLMMessage({
				messagesType: 'chatMessages',
				chatMode: 'normal', // use normal mode (no tools) for planning calls
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
				onError: ({ message: errMsg }) => {
					this._abortCurrentLLM = null
					this._lastLLMError = errMsg || 'Unknown LLM error'
					console.error('[AgentPipeline] LLM Error:', errMsg)
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
