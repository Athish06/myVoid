import * as React from 'react';
import { useState, useEffect } from 'react';
import { useAccessor, useAgentPipelineState } from '../util/services.js'
import { AgentTask, PipelinePhase, AgentPlan } from '../../../../common/agentPipelineTypes.js'
import { validatePlan, importPlanFromAI, formatPlanForExternalAI } from '../../../../common/planExportImport.js'
import { Copy as CopyIcon, Pencil, Save, Trash2, Plus, ChevronDown, ChevronUp, ChevronRight, ListChecks, FileText, ArrowLeft, Bot, Loader2, Circle, CheckCircle2, XCircle, AlertTriangle, PauseCircle, PlayCircle, XOctagon } from 'lucide-react'

export const AgentPipelinePanel = ({
	className = ''
}: {
	className?: string
}) => {
	const accessor = useAccessor()
	const pipelineService = accessor.get('IAgentPipelineService')
	const state = useAgentPipelineState()

	const [activeDropdown, setActiveDropdown] = useState<'tasks' | 'plan' | null>(null)

	useEffect(() => {
		if (state?.phase === 'plan_review') {
			setActiveDropdown('plan')
		} else if (state?.phase === 'executing') {
			setActiveDropdown(null)
		}
	}, [state?.phase])

	if (!state || (state.phase === 'idle' && !state.error)) return null

	const toggleDropdown = (d: 'tasks' | 'plan') => {
		setActiveDropdown(activeDropdown === d ? null : d)
	}

	return (
		<div className={`flex flex-col gap-1.5 p-3 border-b border-void-border-1 bg-void-bg-1 ${className}`}>
			{/* Top Bar */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-1.5">
					<Bot size={14} className="text-void-fg-3" />
					<span className="font-semibold text-void-fg-2 tracking-wide uppercase text-[11px]">Agent Pipeline</span>
				</div>
				<div className="flex items-center gap-1 px-1.5 py-0.5 bg-void-bg-2 border border-void-border-3 rounded text-[9px] text-void-fg-3 font-medium tracking-wider">
					<span>{state.phase === 'idle' ? 'IDLE' : state.phase.toUpperCase().replace('_', ' ')}</span>
				</div>
			</div>

			<PipelineStatusBar phase={state.phase} error={state.error} />

			{/* Navigation Tabs */}
			<div className="flex items-center gap-1 border-b border-void-border-3 pb-1.5">
				<button 
					className={`flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded transition-colors ${activeDropdown === 'plan' ? 'bg-void-bg-3 text-void-fg-1' : 'text-void-fg-3 hover:bg-void-bg-2'}`}
					onClick={() => toggleDropdown('plan')}
				>
					<FileText size={11} />
					Plan
				</button>
				<button 
					className={`flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded transition-colors ${activeDropdown === 'tasks' ? 'bg-void-bg-3 text-void-fg-1' : 'text-void-fg-3 hover:bg-void-bg-2'}`}
					onClick={() => toggleDropdown('tasks')}
				>
					<ListChecks size={11} />
					Tasks
				</button>
			</div>

			{/* Dropdown Contents */}
			<div className="flex flex-col gap-1.5">
				{activeDropdown === 'plan' && state.currentPlan && (
					<div className="p-2 bg-void-bg-2 border border-void-border-3 rounded mt-1">
						<div className="flex justify-between items-center mb-2 pb-1.5 border-b border-void-border-3">
							<span className="text-[10px] font-semibold text-void-fg-3 uppercase tracking-wider flex items-center gap-1"><FileText size={10}/> Execution Plan</span>
							<button 
								className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 bg-void-bg-1 hover:bg-void-bg-3 border border-void-border-3 rounded text-void-fg-3 hover:text-void-fg-1 transition-colors"
								onClick={() => setActiveDropdown(null)}
							>
								<ArrowLeft size={10} />
								Back
							</button>
						</div>
						<PlanReviewPanel
							plan={state.currentPlan}
							onApprove={() => pipelineService.approvePlan()}
							onUpdate={(p) => pipelineService.updatePlan(p)}
							onCancel={() => pipelineService.cancelPipeline()}
							showControls={state.phase === 'plan_review'}
						/>
					</div>
				)}

				{activeDropdown === 'tasks' && state.currentPlan && (
					<div className="p-2 bg-void-bg-2 border border-void-border-3 rounded mt-1">
						<div className="flex justify-between items-center mb-2 pb-1.5 border-b border-void-border-3">
							<span className="text-[10px] font-semibold text-void-fg-3 uppercase tracking-wider flex items-center gap-1"><ListChecks size={10}/> Task List</span>
							<button 
								className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 bg-void-bg-1 hover:bg-void-bg-3 border border-void-border-3 rounded text-void-fg-3 hover:text-void-fg-1 transition-colors"
								onClick={() => setActiveDropdown(null)}
							>
								<ArrowLeft size={10} />
								Back
							</button>
						</div>
						<TaskExecutionPanel
							plan={state.currentPlan}
							currentIndex={state.currentTaskIndex}
							phase={state.phase}
							onPause={() => pipelineService.pausePipeline()}
							onResume={() => pipelineService.resumePipeline()}
							onCancel={() => pipelineService.cancelPipeline()}
							onUpdatePlan={(p) => pipelineService.updatePlan(p)}
						/>
					</div>
				)}
				
				{activeDropdown === 'tasks' && state.phase === 'planning' && (
					<div className="text-[10px] text-void-fg-3 font-mono p-2 bg-void-bg-1 rounded border border-void-border-3 overflow-hidden text-ellipsis whitespace-nowrap">
						{state.executionLog || 'Initializing...'}
					</div>
				)}
			</div>
		</div>
	)
}


const PipelineStatusBar = ({ phase, error }: { phase: PipelinePhase, error: string | null }) => {
	let statusText = 'Idle'
	let StatusIcon: React.ReactNode = null

	switch (phase) {
		case 'planning':
			statusText = 'Generating plan...'
			StatusIcon = <Loader2 size={12} className="text-void-fg-3 animate-spin" />
			break
		case 'plan_review':
			statusText = 'Awaiting approval'
			StatusIcon = <PauseCircle size={12} className="text-void-fg-3" />
			break
		case 'executing':
			statusText = 'Executing...'
			StatusIcon = <Loader2 size={12} className="text-void-fg-3 animate-spin" />
			break
		case 'paused':
			statusText = 'Paused'
			StatusIcon = <PauseCircle size={12} className="text-void-fg-3" />
			break
		case 'done':
			statusText = 'Complete'
			StatusIcon = <CheckCircle2 size={12} className="text-[#4caf50]" />
			break
	}

	if (error) {
		statusText = 'Error'
		StatusIcon = <AlertTriangle size={12} className="text-void-error" />
	}

	return (
		<div className="flex items-center gap-1.5 px-0.5 text-[10px] py-0.5">
			{StatusIcon}
			<span className={error ? 'text-void-error' : 'text-void-fg-3'}>{error || statusText}</span>
		</div>
	)
}


const PlanReviewPanel = ({
	plan,
	onApprove,
	onUpdate,
	onCancel,
	showControls
}: {
	plan: AgentPlan
	onApprove: () => void
	onUpdate: (plan: AgentPlan) => void
	onCancel: () => void
	showControls: boolean
}) => {
	const [activeTab, setActiveTab] = useState<'edit' | 'paste'>('edit')
	const [pasteInput, setPasteInput] = useState('')
	const [pasteError, setPasteError] = useState<string | null>(null)

	const accessor = useAccessor()
	const clipboardService = accessor.get('IClipboardService')

	const handlePastePlan = () => {
		const result = importPlanFromAI(pasteInput)
		if (result.success && result.tasks) {
			onUpdate({ ...plan, tasks: result.tasks })
			setActiveTab('edit')
			setPasteError(null)
			setPasteInput('')
		} else {
			setPasteError(result.errors?.join('\n') || 'Failed to parse plan')
		}
	}

	const handleCopyForAI = () => {
		const text = formatPlanForExternalAI(plan)
		clipboardService.writeText(text)
	}

	return (
		<div className="flex flex-col gap-1.5 overflow-hidden max-h-[80vh]">
			<div className="flex gap-1.5 border-b border-void-border-3 pb-1">
				<button
					className={`text-[10px] px-1.5 py-0.5 rounded ${activeTab === 'edit' ? 'bg-void-bg-3 text-void-fg-1 font-medium' : 'text-void-fg-3 hover:bg-void-bg-1'}`}
					onClick={() => setActiveTab('edit')}
				>
					Edit
				</button>
				<button
					className={`text-[10px] px-1.5 py-0.5 rounded ${activeTab === 'paste' ? 'bg-void-bg-3 text-void-fg-1 font-medium' : 'text-void-fg-3 hover:bg-void-bg-1'}`}
					onClick={() => setActiveTab('paste')}
				>
					Import JSON
				</button>
				<div className="flex-grow" />
				<button
					className="text-[9px] px-1.5 py-0.5 rounded flex items-center gap-1 hover:bg-void-bg-1 text-void-fg-3"
					onClick={handleCopyForAI}
					title="Copy plan to clipboard"
				>
					<CopyIcon size={9} /> Copy
				</button>
			</div>

			{activeTab === 'edit' ? (
				<TaskEditorList plan={plan} onUpdate={onUpdate} />
			) : (
				<div className="flex flex-col gap-1.5">
					<textarea
						value={pasteInput}
						onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setPasteInput(e.target.value)}
						className="w-full h-40 bg-void-bg-1 border border-void-border-3 rounded p-2 text-[10px] font-mono text-void-fg-2 resize-none focus:outline-none focus:border-void-border-1"
						placeholder='{"tasks": [...]}'
					/>
					{pasteError && <div className="text-[10px] text-void-error whitespace-pre-wrap">{pasteError}</div>}
					<button
						className="text-[10px] px-2 py-1 bg-void-bg-1 hover:bg-void-bg-3 text-void-fg-1 border border-void-border-3 rounded self-end"
						onClick={handlePastePlan}
					>
						Use Plan
					</button>
				</div>
			)}

			{showControls && (
				<div className="flex gap-2 justify-end mt-2 pt-2 border-t border-void-border-3">
					<button
						className="px-3 py-1 bg-transparent border border-void-border-3 hover:border-void-error hover:text-void-error text-void-fg-3 rounded text-[10px] font-medium transition-all duration-150"
						onClick={onCancel}
					>
						Cancel
					</button>
					<button
						className="px-3 py-1 bg-void-fg-1 text-void-bg-1 hover:opacity-90 rounded text-[10px] font-medium transition-all duration-150"
						onClick={onApprove}
					>
						Approve Plan
					</button>
				</div>
			)}
		</div>
	)
}


const TaskEditorList = ({ plan, onUpdate }: { plan: AgentPlan, onUpdate: (p: AgentPlan) => void }) => {
	const errors = validatePlan(plan.tasks)

	const updateTask = (index: number, updates: Partial<AgentTask>) => {
		const newTasks = [...plan.tasks]
		newTasks[index] = { ...newTasks[index], ...updates }
		onUpdate({ ...plan, tasks: newTasks })
	}

	const deleteTask = (index: number) => {
		const newTasks = [...plan.tasks]
		newTasks.splice(index, 1)
		onUpdate({ ...plan, tasks: newTasks })
	}

	const moveTask = (index: number, direction: 'up' | 'down') => {
		const newTasks = [...plan.tasks]
		if (direction === 'up' && index > 0) {
			const temp = newTasks[index - 1]
			newTasks[index - 1] = newTasks[index]
			newTasks[index] = temp
			onUpdate({ ...plan, tasks: newTasks })
		} else if (direction === 'down' && index < newTasks.length - 1) {
			const temp = newTasks[index + 1]
			newTasks[index + 1] = newTasks[index]
			newTasks[index] = temp
			onUpdate({ ...plan, tasks: newTasks })
		}
	}

	const addTask = () => {
		const newId = `task_${Math.random().toString(36).slice(2, 7)}`
		onUpdate({
			...plan,
			tasks: [...plan.tasks, {
				id: newId,
				title: 'New Task',
				description: '',
				targetFiles: [],
				dependsOn: plan.tasks.length > 0 ? [plan.tasks[plan.tasks.length - 1].id] : [],
				taskType: 'modify',
				status: 'pending'
			}]
		})
	}

	return (
		<div className="flex flex-col gap-1.5 overflow-y-auto pr-1 max-h-[50vh]">
			{errors.length > 0 && (
				<div className="text-[10px] text-void-error bg-void-error/10 p-1.5 rounded">
					{errors.map((e: string, i: number) => <div key={i}>- {e}</div>)}
				</div>
			)}
			
			<div className="flex flex-col gap-1.5">
				{plan.tasks.map((task: AgentTask, i: number) => (
					<TaskEditorItem 
						key={task.id} 
						task={task} 
						index={i}
						isFirst={i === 0}
						isLast={i === plan.tasks.length - 1}
						onUpdate={(u) => updateTask(i, u)} 
						onDelete={() => deleteTask(i)}
						onMove={(dir) => moveTask(i, dir)}
					/>
				))}
			</div>
			
			<button 
				className="text-[10px] flex items-center justify-center gap-1 py-1 border border-dashed border-void-border-3 text-void-fg-3 hover:text-void-fg-1 hover:border-void-border-1 rounded mt-1 transition-colors"
				onClick={addTask}
			>
				<Plus size={10} /> Add Task
			</button>
		</div>
	)
}


const TaskEditorItem = ({ 
	task, 
	index,
	isFirst,
	isLast,
	onUpdate, 
	onDelete,
	onMove
}: { 
	task: AgentTask, 
	index: number,
	isFirst: boolean,
	isLast: boolean,
	onUpdate: (u: Partial<AgentTask>) => void,
	onDelete: () => void,
	onMove: (dir: 'up' | 'down') => void
}) => {
	const [isEditing, setIsEditing] = useState(false)

	if (!isEditing) {
		return (
			<div className="group flex flex-col gap-0.5 p-1.5 bg-void-bg-1 border border-void-border-3 rounded hover:border-void-border-2 transition-colors">
				<div className="flex items-center justify-between">
					<div className="text-[10px] font-medium text-void-fg-1 truncate flex items-center gap-1.5">
						<span className="text-void-fg-4 font-mono">{index + 1}.</span> {task.title}
					</div>
					<div className="flex gap-0.5 text-void-fg-3">
						{!isFirst && <button onClick={() => onMove('up')} className="hover:text-void-fg-1 p-0.5 bg-void-bg-2 rounded border border-void-border-3" title="Move Up"><ChevronUp size={10} /></button>}
						{!isLast && <button onClick={() => onMove('down')} className="hover:text-void-fg-1 p-0.5 bg-void-bg-2 rounded border border-void-border-3" title="Move Down"><ChevronDown size={10} /></button>}
						<button onClick={() => setIsEditing(true)} className="hover:text-void-fg-1 p-0.5 ml-1"><Pencil size={10} /></button>
						<button onClick={onDelete} className="hover:text-void-error p-0.5"><Trash2 size={10} /></button>
					</div>
				</div>
				<div className="text-[9px] text-void-fg-4 truncate">{task.description}</div>
			</div>
		)
	}

	return (
		<div className="flex flex-col gap-1.5 p-1.5 bg-void-bg-2 border border-void-border-1 rounded">
			<input 
				value={task.title}
				onChange={(e: React.ChangeEvent<HTMLInputElement>) => onUpdate({ title: e.target.value })}
				className="bg-void-bg-1 border border-void-border-3 rounded px-2 py-0.5 text-[10px] focus:outline-none focus:border-void-border-1 text-void-fg-1"
				placeholder="Task Title"
			/>
			<textarea 
				value={task.description}
				onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onUpdate({ description: e.target.value })}
				className="bg-void-bg-1 border border-void-border-3 rounded px-2 py-0.5 text-[9px] resize-none h-14 focus:outline-none focus:border-void-border-1 text-void-fg-2"
				placeholder="Task Description"
			/>
			<div className="flex justify-end mt-0.5">
				<button 
					onClick={() => setIsEditing(false)}
					className="text-[9px] px-1.5 py-0.5 bg-void-bg-1 hover:bg-void-bg-3 text-void-fg-1 border border-void-border-3 rounded flex items-center gap-1"
				>
					<Save size={9} /> Done
				</button>
			</div>
		</div>
	)
}


const TaskExecutionPanel = ({
	plan,
	currentIndex,
	phase,
	onPause,
	onResume,
	onCancel,
	onUpdatePlan
}: {
	plan: AgentPlan
	currentIndex: number
	phase: PipelinePhase
	onPause: () => void
	onResume: () => void
	onCancel: () => void
	onUpdatePlan: (p: AgentPlan) => void
}) => {
	const doneCount = plan.tasks.filter((t: AgentTask) => t.status === 'done').length
	const totalCount = plan.tasks.length
	const canReorder = phase === 'paused' || phase === 'plan_review'
	
	const renderStatus = (status: AgentTask['status']) => {
		switch (status) {
			case 'pending': return <Circle size={11} className="text-void-fg-4" />
			case 'running': return <Loader2 size={11} className="text-[#3794ff] animate-spin" />
			case 'done': return <CheckCircle2 size={11} className="text-[#4caf50]" />
			case 'failed': return <XCircle size={11} className="text-void-error" />
		}
	}

	const moveTask = (index: number, direction: 'up' | 'down') => {
		const newTasks = [...plan.tasks]
		if (direction === 'up' && index > 0 && newTasks[index].status === 'pending' && newTasks[index - 1].status === 'pending') {
			const temp = newTasks[index - 1]
			newTasks[index - 1] = newTasks[index]
			newTasks[index] = temp
			onUpdatePlan({ ...plan, tasks: newTasks })
		} else if (direction === 'down' && index < newTasks.length - 1 && newTasks[index].status === 'pending' && newTasks[index + 1].status === 'pending') {
			const temp = newTasks[index + 1]
			newTasks[index + 1] = newTasks[index]
			newTasks[index] = temp
			onUpdatePlan({ ...plan, tasks: newTasks })
		}
	}

	return (
		<div className="flex flex-col gap-1.5">
			{/* Progress */}
			<div className="flex items-center justify-between text-[9px] text-void-fg-3">
				<span>Progress</span>
				<span className="font-mono">{doneCount}/{totalCount}</span>
			</div>
			
			<div className="w-full bg-void-bg-1 rounded-full h-[3px]">
				<div className="bg-[#3794ff] h-[3px] rounded-full transition-all duration-500" style={{ width: `${totalCount > 0 ? (doneCount/totalCount)*100 : 0}%` }}></div>
			</div>

			{/* Task list */}
			<div className="flex flex-col gap-0.5 max-h-48 overflow-y-auto pt-1">
				{plan.tasks.map((task: AgentTask, i: number) => (
					<div 
						key={task.id} 
						className={`flex items-center gap-1.5 text-[10px] py-1 px-1.5 rounded transition-colors
							${i === currentIndex && phase === 'executing' ? 'bg-void-bg-1 border border-void-border-3 text-void-fg-1 font-medium' : 'border border-transparent'}
							${task.status === 'done' ? 'text-void-fg-4 opacity-60' : 'text-void-fg-2'}
						`}
					>
						<div className="flex-shrink-0">{renderStatus(task.status)}</div>
						<div className="truncate flex-grow">{task.title}</div>
						{canReorder && task.status === 'pending' && (
							<div className="flex gap-0.5 flex-shrink-0">
								{i > 0 && plan.tasks[i - 1]?.status === 'pending' && (
									<button onClick={() => moveTask(i, 'up')} className="text-void-fg-4 hover:text-void-fg-1 p-0.5"><ChevronUp size={10} /></button>
								)}
								{i < plan.tasks.length - 1 && plan.tasks[i + 1]?.status === 'pending' && (
									<button onClick={() => moveTask(i, 'down')} className="text-void-fg-4 hover:text-void-fg-1 p-0.5"><ChevronDown size={10} /></button>
								)}
							</div>
						)}
					</div>
				))}
			</div>

			{/* Controls */}
			<div className="flex justify-end gap-1.5 mt-1.5 pt-1.5 border-t border-void-border-3">
				{phase === 'executing' ? (
					<button className="text-[10px] px-2 py-0.5 rounded border border-void-border-3 hover:bg-void-bg-1 text-void-fg-2 transition-colors flex items-center gap-1" onClick={onPause}><PauseCircle size={10} /> Pause</button>
				) : phase === 'paused' ? (
					<>
						<button className="text-[10px] px-2 py-0.5 rounded border border-void-border-3 hover:border-void-error hover:text-void-error text-void-fg-3 transition-colors flex items-center gap-1" onClick={onCancel}><XOctagon size={10} /> Cancel</button>
						<button className="text-[10px] px-2 py-0.5 rounded bg-void-fg-1 text-void-bg-1 hover:opacity-90 transition-opacity flex items-center gap-1" onClick={onResume}><PlayCircle size={10} /> Resume</button>
					</>
				) : null}
			</div>
		</div>
	)
}
