import * as React from 'react';
import { useState, useEffect } from 'react';
import { useAccessor, useAgentPipelineState } from '../util/services.js'
import { AgentTask, PipelinePhase, AgentPlan } from '../../../../common/agentPipelineTypes.js'
import { IconLoading, IconWarning } from './SidebarChat.js'
import { validatePlan, importPlanFromAI, formatPlanForExternalAI } from '../../../../common/planExportImport.js'
import { Copy as CopyIcon, Pencil, Save, Trash2, Plus, ChevronDown, ChevronUp, ChevronRight, ListChecks, FileText, ArrowLeft } from 'lucide-react'

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
		<div className={`flex flex-col gap-2 p-3 border-b border-void-border-1 bg-void-bg-1 shadow-sm ${className}`}>
			{/* Top Bar with Mode Indicator */}
			<div className="flex items-center justify-between mb-1">
				<div className="flex items-center gap-2">
					<span className="text-base">🤖</span>
					<span className="font-bold text-void-fg-1 tracking-wide uppercase text-sm">AGENT</span>
				</div>
				<div className="flex items-center gap-1 px-2 py-0.5 bg-[#d29922]/20 border border-[#d29922]/50 rounded-full text-[10px] text-[#d29922] font-semibold tracking-wider">
					<span>REVIEW-DRIVEN</span>
				</div>
			</div>

			<PipelineStatusBar phase={state.phase} error={state.error} />

			{/* Navigation Tabs */}
			<div className="flex items-center gap-2 mt-1 border-b border-void-border-3 pb-2">
				<button 
					className={`flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded transition-colors ${activeDropdown === 'plan' ? 'bg-void-bg-3 text-void-fg-1' : 'text-void-fg-3 hover:bg-void-bg-2'}`}
					onClick={() => toggleDropdown('plan')}
				>
					<FileText size={12} />
					Execution Plan
				</button>
				<button 
					className={`flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded transition-colors ${activeDropdown === 'tasks' ? 'bg-void-bg-3 text-void-fg-1' : 'text-void-fg-3 hover:bg-void-bg-2'}`}
					onClick={() => toggleDropdown('tasks')}
				>
					<ListChecks size={12} />
					Task List
				</button>
			</div>

			{/* Dropdown Contents */}
			<div className="flex flex-col gap-2">
				{activeDropdown === 'plan' && state.currentPlan && (
					<div className="p-2 bg-void-bg-3 border border-void-border-2 rounded-md shadow-inner mt-2">
						<div className="flex justify-between items-center mb-2 pb-2 border-b border-void-border-1">
							<span className="text-xs font-semibold text-void-fg-2 uppercase tracking-wider flex items-center gap-1"><FileText size={12}/> Execution Plan</span>
							<button 
								className="flex items-center gap-1 text-xs px-2 py-1 bg-void-bg-1 hover:bg-void-bg-2 border border-void-border-1 rounded text-void-fg-3 hover:text-void-fg-1 transition-colors"
								onClick={() => setActiveDropdown(null)}
							>
								<ArrowLeft size={12} />
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
					<div className="p-2 bg-void-bg-3 border border-void-border-2 rounded-md shadow-inner mt-2">
						<div className="flex justify-between items-center mb-2 pb-2 border-b border-void-border-1">
							<span className="text-xs font-semibold text-void-fg-2 uppercase tracking-wider flex items-center gap-1"><ListChecks size={12}/> Task List</span>
							<button 
								className="flex items-center gap-1 text-xs px-2 py-1 bg-void-bg-1 hover:bg-void-bg-2 border border-void-border-1 rounded text-void-fg-3 hover:text-void-fg-1 transition-colors"
								onClick={() => setActiveDropdown(null)}
							>
								<ArrowLeft size={12} />
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
						/>
					</div>
				)}
				
				{activeDropdown === 'tasks' && state.phase === 'planning' && (
					<div className="text-sm text-void-fg-3 font-mono p-2 bg-void-bg-1 rounded border border-void-border-3 overflow-hidden text-ellipsis whitespace-nowrap">
						{state.executionLog || 'Initializing...'}
					</div>
				)}
			</div>
		</div>
	)
}


const PipelineStatusBar = ({ phase, error }: { phase: PipelinePhase, error: string | null }) => {
	let statusText = 'Idle'
	let Icon = null

	switch (phase) {
		case 'planning':
			statusText = 'Generating Implementation Plan...'
			Icon = IconLoading
			break
		case 'plan_review':
			statusText = 'Waiting for Plan Approval'
			break
		case 'executing':
			statusText = 'Executing Tasks...'
			Icon = IconLoading
			break
		case 'paused':
			statusText = 'Execution Paused'
			break
		case 'done':
			statusText = 'All Tasks Completed'
			break
	}

	if (error) {
		statusText = 'Error'
		Icon = IconWarning
	}

	return (
		<div className="flex items-center gap-2 font-medium px-1 text-xs py-1">
			{Icon && <Icon className={error ? 'text-void-error' : 'text-[#3794ff]'} size={14} />}
			<span className={error ? 'text-void-error' : 'text-void-fg-2 tracking-wide'}>{error || statusText}</span>
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
		<div className="flex flex-col gap-2 overflow-hidden max-h-[80vh]">
			<div className="flex gap-2 border-b border-void-border-3 pb-1">
				<button
					className={`text-xs px-2 py-1 rounded ${activeTab === 'edit' ? 'bg-void-bg-3 text-void-fg-1 font-medium' : 'text-void-fg-3 hover:bg-void-bg-1'}`}
					onClick={() => setActiveTab('edit')}
				>
					Edit
				</button>
				<button
					className={`text-xs px-2 py-1 rounded ${activeTab === 'paste' ? 'bg-void-bg-3 text-void-fg-1 font-medium' : 'text-void-fg-3 hover:bg-void-bg-1'}`}
					onClick={() => setActiveTab('paste')}
				>
					Import AI JSON
				</button>
				<div className="flex-grow" />
				<button
					className="text-[10px] px-2 py-0.5 rounded flex items-center gap-1 hover:bg-void-bg-1 text-void-fg-3"
					onClick={handleCopyForAI}
					title="Copy plan to clipboard"
				>
					<CopyIcon size={10} /> Copy
				</button>
			</div>

			{activeTab === 'edit' ? (
				<TaskEditorList plan={plan} onUpdate={onUpdate} />
			) : (
				<div className="flex flex-col gap-2">
					<textarea
						value={pasteInput}
						onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setPasteInput(e.target.value)}
						className="w-full h-48 bg-void-bg-1 border border-void-border-3 rounded p-2 text-xs font-mono text-void-fg-2 resize-none focus:outline-none focus:border-void-border-1"
						placeholder='{"tasks": [...]}'
					/>
					{pasteError && <div className="text-xs text-void-error whitespace-pre-wrap">{pasteError}</div>}
					<button
						className="text-xs px-3 py-1 bg-void-bg-1 hover:bg-void-bg-3 text-void-fg-1 border border-void-border-3 rounded self-end"
						onClick={handlePastePlan}
					>
						Use Plan
					</button>
				</div>
			)}

			{showControls && (
				<div className="flex gap-2 justify-end mt-3 pt-3 border-t border-void-border-3">
					<button
						className="px-4 py-1.5 bg-transparent border border-[#f85149] hover:bg-[#f85149]/10 text-[#f85149] rounded-md text-xs font-semibold transition-all duration-150"
						onClick={onCancel}
					>
						❌ Cancel
					</button>
					<button
						className="px-4 py-1.5 bg-[#238636] hover:bg-[#2ea043] active:bg-[#238636] text-white rounded-md text-xs font-semibold shadow-sm transition-all duration-150"
						onClick={onApprove}
					>
						✅ Approve Plan
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
		<div className="flex flex-col gap-2 overflow-y-auto pr-1 max-h-[50vh]">
			{errors.length > 0 && (
				<div className="text-xs text-void-error bg-void-error/10 p-2 rounded">
					{errors.map((e: string, i: number) => <div key={i}>• {e}</div>)}
				</div>
			)}
			
			<div className="flex flex-col gap-2">
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
				className="text-xs flex items-center justify-center gap-1 py-1 border border-dashed border-void-border-3 text-void-fg-3 hover:text-void-fg-1 hover:border-void-border-1 rounded mt-1 transition-colors"
				onClick={addTask}
			>
				<Plus size={12} /> Add Task
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
			<div className="group flex flex-col gap-1 p-2 bg-void-bg-1 border border-void-border-3 rounded hover:border-void-border-2 transition-colors">
				<div className="flex items-center justify-between">
					<div className="text-xs font-medium text-void-fg-1 truncate flex items-center gap-2">
						<span className="text-void-fg-4 font-mono">{index + 1}.</span> {task.title}
					</div>
					<div className="flex gap-1 text-void-fg-3">
                        {!isFirst && <button onClick={() => onMove('up')} className="hover:text-void-fg-1 p-0.5 bg-void-bg-2 rounded border border-void-border-3" title="Move Up"><ChevronUp size={12} /></button>}
                        {!isLast && <button onClick={() => onMove('down')} className="hover:text-void-fg-1 p-0.5 bg-void-bg-2 rounded border border-void-border-3" title="Move Down"><ChevronDown size={12} /></button>}
						<button onClick={() => setIsEditing(true)} className="hover:text-void-fg-1 p-0.5 ml-2"><Pencil size={12} /></button>
						<button onClick={onDelete} className="hover:text-void-error p-0.5"><Trash2 size={12} /></button>
					</div>
				</div>
				<div className="text-[10px] text-void-fg-3 truncate">{task.description}</div>
			</div>
		)
	}

	return (
		<div className="flex flex-col gap-2 p-2 bg-void-bg-2 border border-void-border-1 rounded">
			<input 
				value={task.title}
				onChange={(e: React.ChangeEvent<HTMLInputElement>) => onUpdate({ title: e.target.value })}
				className="bg-void-bg-1 border border-void-border-3 rounded px-2 py-1 text-xs focus:outline-none focus:border-void-border-1 text-void-fg-1"
				placeholder="Task Title"
			/>
			<textarea 
				value={task.description}
				onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onUpdate({ description: e.target.value })}
				className="bg-void-bg-1 border border-void-border-3 rounded px-2 py-1 text-[10px] resize-none h-16 focus:outline-none focus:border-void-border-1 text-void-fg-2"
				placeholder="Task Description"
			/>
			<div className="flex justify-end mt-1">
				<button 
					onClick={() => setIsEditing(false)}
					className="text-[10px] px-2 py-1 bg-void-bg-1 hover:bg-void-bg-3 text-void-fg-1 border border-void-border-3 rounded flex items-center gap-1"
				>
					<Save size={10} /> Done
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
	onCancel
}: {
	plan: AgentPlan
	currentIndex: number
	phase: PipelinePhase
	onPause: () => void
	onResume: () => void
	onCancel: () => void
}) => {
	const doneCount = plan.tasks.filter((t: AgentTask) => t.status === 'done').length
	const totalCount = plan.tasks.length
	
	const renderStatus = (status: AgentTask['status']) => {
		switch (status) {
			case 'pending': return <span className="text-void-fg-4">○</span>
			case 'running': return <span className="text-[#e8b548] animate-pulse">◉</span>
			case 'done': return <span className="text-[#4caf50]">✓</span>
			case 'failed': return <span className="text-void-error">✗</span>
		}
	}

	return (
		<div className="flex flex-col gap-2">
			{/* Progress */}
			<div className="flex items-center justify-between text-[10px] text-void-fg-3">
				<span>Progress</span>
				<span className="font-mono">{doneCount}/{totalCount} tasks completed</span>
			</div>
			
			<div className="w-full bg-void-bg-1 rounded-full h-1">
				<div className="bg-[#4caf50] h-1 rounded-full transition-all duration-500" style={{ width: `${(doneCount/totalCount)*100}%` }}></div>
			</div>

			{/* Task list */}
			<div className="flex flex-col gap-1 max-h-48 overflow-y-auto pt-2">
				{plan.tasks.map((task: AgentTask, i: number) => (
					<div 
						key={task.id} 
						className={`flex items-center gap-2 text-xs py-1 px-2 rounded transition-colors
							${i === currentIndex && phase === 'executing' ? 'bg-void-bg-1 border border-void-border-3 text-void-fg-1 font-medium' : 'border border-transparent'}
							${task.status === 'done' ? 'text-void-fg-4 opacity-70' : 'text-void-fg-2'}
						`}
					>
						<div className="flex-shrink-0">{renderStatus(task.status)}</div>
						<div className="truncate">{task.title}</div>
					</div>
				))}
			</div>

			{/* Controls */}
			<div className="flex justify-end gap-2 mt-2 pt-2 border-t border-void-border-3">
				{phase === 'executing' ? (
					<button className="text-xs px-3 py-1 rounded border border-void-border-3 hover:bg-void-bg-1 text-void-fg-2 transition-colors" onClick={onPause}>Pause</button>
				) : phase === 'paused' ? (
					<>
						<button className="text-xs px-3 py-1 rounded border border-void-border-3 hover:bg-void-bg-1 text-void-fg-2 transition-colors" onClick={onCancel}>Cancel Pipeline</button>
						<button className="text-xs px-3 py-1 rounded bg-void-fg-1 text-void-bg-1 hover:opacity-90 transition-opacity" onClick={onResume}>Resume</button>
					</>
				) : null}
			</div>
		</div>
	)
}
