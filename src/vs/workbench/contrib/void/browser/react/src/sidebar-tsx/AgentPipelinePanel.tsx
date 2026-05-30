/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as React from 'react';
import { useState, useEffect, useRef } from 'react';
import { useAccessor, useAgentPipelineState, useSettingsState } from '../util/services.js'
import { AgentTask, PipelinePhase, AgentPlan } from '../../../../common/agentPipelineTypes.js'
import { IconLoading, IconSquare, IconX, IconWarning } from './SidebarChat.js'
import { ModelDropdown } from '../void-settings-tsx/ModelDropdown.js'
import { validatePlan, importPlanFromAI, formatPlanForExternalAI } from '../../../../common/planExportImport.js'
import { Check, Copy as CopyIcon, Pencil, Save, Trash2, GripVertical, Plus } from 'lucide-react'


export const AgentPipelinePanel = ({
	className = ''
}: {
	className?: string
}) => {
	const accessor = useAccessor()
	const pipelineService = accessor.get('IAgentPipelineService')
	const state = useAgentPipelineState()

	if (!state || state.phase === 'idle') return null

	return (
		<div className={`flex flex-col gap-2 p-2 border-b border-void-border-2 bg-void-bg-2 ${className}`}>
			<PipelineStatusBar phase={state.phase} error={state.error} />

			{state.phase === 'planning' && (
				<div className="text-sm text-void-fg-3 font-mono p-2 bg-void-bg-1 rounded border border-void-border-3 overflow-hidden text-ellipsis whitespace-nowrap">
					{state.executionLog || 'Initializing...'}
				</div>
			)}

			{state.phase === 'plan_review' && state.currentPlan && (
				<PlanReviewPanel
					plan={state.currentPlan}
					onApprove={() => pipelineService.approvePlan()}
					onUpdate={(p) => pipelineService.updatePlan(p)}
					onCancel={() => pipelineService.cancelPipeline()}
				/>
			)}

			{(state.phase === 'executing' || state.phase === 'paused' || state.phase === 'done') && state.currentPlan && (
				<TaskExecutionPanel
					plan={state.currentPlan}
					currentIndex={state.currentTaskIndex}
					phase={state.phase}
					onPause={() => pipelineService.pausePipeline()}
					onResume={() => pipelineService.resumePipeline()}
					onCancel={() => pipelineService.cancelPipeline()}
				/>
			)}
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
			statusText = 'Review Implementation Plan'
			break
		case 'executing':
			statusText = 'Executing Plan...'
			Icon = IconLoading
			break
		case 'paused':
			statusText = 'Execution Paused'
			break
		case 'done':
			statusText = 'Plan Execution Complete'
			break
	}

	if (error) {
		statusText = 'Error'
		Icon = IconWarning
	}

	return (
		<div className="flex items-center gap-2 font-medium text-void-fg-1">
			{Icon && <Icon className={error ? 'text-void-error' : 'text-void-fg-3'} size={14} />}
			<span className={error ? 'text-void-error' : ''}>{error || statusText}</span>
		</div>
	)
}


const PlanReviewPanel = ({
	plan,
	onApprove,
	onUpdate,
	onCancel
}: {
	plan: AgentPlan
	onApprove: () => void
	onUpdate: (plan: AgentPlan) => void
	onCancel: () => void
}) => {
	const [activeTab, setActiveTab] = useState<'edit' | 'paste'>('edit')
	const [pasteInput, setPasteInput] = useState('')
	const [pasteError, setPasteError] = useState<string | null>(null)

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
		navigator.clipboard.writeText(text)
	}

	return (
		<div className="flex flex-col gap-2 flex-grow overflow-hidden max-h-[80vh]">
			<div className="text-xs text-void-fg-3 bg-void-bg-1 p-2 rounded">
				<strong>Refined Prompt:</strong> {plan.refinedPrompt}
			</div>

			<div className="flex gap-2 border-b border-void-border-3 pb-1">
				<button
					className={`text-xs px-2 py-1 rounded ${activeTab === 'edit' ? 'bg-void-bg-3 text-void-fg-1' : 'text-void-fg-3 hover:bg-void-bg-1'}`}
					onClick={() => setActiveTab('edit')}
				>
					Edit Tasks
				</button>
				<button
					className={`text-xs px-2 py-1 rounded ${activeTab === 'paste' ? 'bg-void-bg-3 text-void-fg-1' : 'text-void-fg-3 hover:bg-void-bg-1'}`}
					onClick={() => setActiveTab('paste')}
				>
					Paste from AI
				</button>
				<div className="flex-grow" />
				<button
					className="text-xs px-2 py-1 rounded flex items-center gap-1 bg-void-bg-1 hover:bg-void-bg-3 text-void-fg-2 border border-void-border-3"
					onClick={handleCopyForAI}
					title="Copy formatted plan to clipboard for ChatGPT/Gemini"
				>
					<CopyIcon size={12} /> Copy for AI
				</button>
			</div>

			{activeTab === 'edit' ? (
				<TaskEditorList plan={plan} onUpdate={onUpdate} />
			) : (
				<div className="flex flex-col gap-2">
					<p className="text-xs text-void-fg-3">Paste the improved JSON plan from an external AI:</p>
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
						Validate & Use
					</button>
				</div>
			)}

			<div className="flex gap-2 justify-end mt-2 pt-2 border-t border-void-border-3">
				<button
					className="text-xs px-3 py-1 rounded hover:bg-void-bg-1 text-void-fg-3"
					onClick={onCancel}
				>
					Cancel
				</button>
				<button
					className="text-xs px-4 py-1 rounded bg-void-fg-1 text-void-bg-1 font-medium hover:opacity-90"
					onClick={onApprove}
				>
					Approve & Execute
				</button>
			</div>
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
		<div className="flex flex-col gap-2 overflow-y-auto pr-1">
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
						onUpdate={(u) => updateTask(i, u)} 
						onDelete={() => deleteTask(i)}
					/>
				))}
			</div>
			
			<button 
				className="text-xs flex items-center justify-center gap-1 py-1.5 border border-dashed border-void-border-3 text-void-fg-3 hover:text-void-fg-1 hover:border-void-border-1 rounded mt-1"
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
	onUpdate, 
	onDelete 
}: { 
	task: AgentTask, 
	index: number, 
	onUpdate: (u: Partial<AgentTask>) => void,
	onDelete: () => void 
}) => {
	const [isEditing, setIsEditing] = useState(false)

	if (!isEditing) {
		return (
			<div className="group flex flex-col gap-1 p-2 bg-void-bg-1 border border-void-border-3 rounded hover:border-void-border-2">
				<div className="flex items-center justify-between">
					<div className="text-sm font-medium text-void-fg-1 truncate flex items-center gap-2">
						<span className="text-xs text-void-fg-4 font-mono">{index + 1}.</span> {task.title}
					</div>
					<div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
						<button onClick={() => setIsEditing(true)} className="text-void-fg-3 hover:text-void-fg-1 p-0.5"><Pencil size={12} /></button>
						<button onClick={onDelete} className="text-void-fg-3 hover:text-void-error p-0.5"><Trash2 size={12} /></button>
					</div>
				</div>
				<div className="text-xs text-void-fg-3 truncate">{task.description}</div>
				<div className="text-[10px] text-void-fg-4 font-mono flex gap-1 mt-1">
					{task.targetFiles.map((f: string) => (
						<span key={f} className="bg-void-bg-2 px-1 rounded truncate max-w-[150px]">{f.split('/').pop()}</span>
					))}
				</div>
			</div>
		)
	}

	return (
		<div className="flex flex-col gap-2 p-2 bg-void-bg-2 border border-void-border-1 rounded">
			<input 
				value={task.title}
				onChange={(e: React.ChangeEvent<HTMLInputElement>) => onUpdate({ title: e.target.value })}
				className="bg-void-bg-1 border border-void-border-3 rounded px-2 py-1 text-sm focus:outline-none focus:border-void-border-1 text-void-fg-1"
				placeholder="Task Title"
			/>
			<textarea 
				value={task.description}
				onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onUpdate({ description: e.target.value })}
				className="bg-void-bg-1 border border-void-border-3 rounded px-2 py-1 text-xs resize-none h-16 focus:outline-none focus:border-void-border-1 text-void-fg-2"
				placeholder="Task Description"
			/>
			<input 
				value={task.targetFiles.join(', ')}
				onChange={(e: React.ChangeEvent<HTMLInputElement>) => onUpdate({ targetFiles: e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean) })}
				className="bg-void-bg-1 border border-void-border-3 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-void-border-1 text-void-fg-3"
				placeholder="Target files (comma separated)"
			/>
			<div className="flex justify-end mt-1">
				<button 
					onClick={() => setIsEditing(false)}
					className="text-xs px-2 py-1 bg-void-bg-1 hover:bg-void-bg-3 text-void-fg-1 border border-void-border-3 rounded flex items-center gap-1"
				>
					<Save size={12} /> Done
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
	
	const renderStatus = (status: AgentTask['status']) => {
		switch (status) {
			case 'pending': return <span className="text-void-fg-4">[ ]</span>
			case 'running': return <span className="text-[#e8b548] animate-pulse">[/]</span>
			case 'done': return <span className="text-[#4caf50]">[✓]</span>
			case 'failed': return <span className="text-void-error">[✗]</span>
		}
	}

	return (
		<div className="flex flex-col gap-2">
			{/* Compact task list */}
			<div className="flex flex-col gap-1 max-h-48 overflow-y-auto">
				{plan.tasks.map((task: AgentTask, i: number) => (
					<div 
						key={task.id} 
						className={`flex items-center gap-2 text-xs p-1 rounded
							${i === currentIndex ? 'bg-void-bg-1 border border-void-border-2' : 'border border-transparent'}
							${task.status === 'done' ? 'opacity-60' : ''}
						`}
					>
						<div className="font-mono flex-shrink-0">{renderStatus(task.status)}</div>
						<div className={`truncate ${i === currentIndex ? 'text-void-fg-1 font-medium' : 'text-void-fg-2'}`}>
							{task.title}
						</div>
					</div>
				))}
			</div>

			{/* Controls */}
			<div className="flex justify-end gap-2 mt-1">
				{phase === 'executing' ? (
					<button className="text-xs px-3 py-1 rounded border border-void-border-3 hover:bg-void-bg-1 text-void-fg-2" onClick={onPause}>Pause</button>
				) : phase === 'paused' ? (
					<>
						<button className="text-xs px-3 py-1 rounded border border-void-border-3 hover:bg-void-bg-1 text-void-fg-2" onClick={onCancel}>Cancel Pipeline</button>
						<button className="text-xs px-3 py-1 rounded bg-void-fg-1 text-void-bg-1 hover:opacity-90" onClick={onResume}>Resume</button>
					</>
				) : null}
			</div>
		</div>
	)
}
