/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { AgentPlan, AgentTask, PlanImportResult } from './agentPipelineTypes.js'


// ======================== Export: Copy for AI ========================

/**
 * Formats the current plan into a prompt suitable for pasting into
 * Gemini, ChatGPT, or another external AI for plan refinement.
 */
export function formatPlanForExternalAI(plan: AgentPlan): string {
	return `\
I am building a feature with a coding agent. Here is the implementation plan it generated.
Please improve it and return ONLY the improved plan as valid JSON.

PROJECT: ${plan.projectSummary}
STACK: ${plan.techStack.join(', ')}
ORIGINAL PROMPT: ${plan.refinedPrompt}

CURRENT PLAN:
${plan.tasks.map((t, i) =>
		`${i + 1}. [${t.id}] ${t.title}
   What: ${t.description}
   Files: ${t.targetFiles.join(', ')}
   Depends on: ${t.dependsOn.join(', ') || 'none'}`
	).join('\n\n')}

Please return an improved plan as JSON in EXACTLY this schema (no other text):
{
  "tasks": [
    {
      "id": "task_001",
      "title": "Short action title",
      "description": "What exactly to do in this task",
      "targetFiles": ["path/to/file.ts"],
      "dependsOn": [],
      "taskType": "create"
    }
  ]
}

Rules to follow when improving:
- Max 10 tasks total
- Each task touches at most 3 files
- Tasks must be ordered by dependency (no task can depend on a later task)
- Split any task that creates AND modifies the same file into 2 tasks
- taskType is one of: create, modify, refactor`.trim()
}


// ======================== Import: Paste from AI ========================

/**
 * Parses and validates plan JSON pasted from an external AI.
 * Handles markdown fences, validates schema, checks dependencies.
 */
export function importPlanFromAI(rawInput: string): PlanImportResult {
	// Step 1: Extract the JSON part if there is surrounding text or markdown fences
	let cleaned = rawInput.trim()
	
	// If it contains markdown code blocks, try to extract just the code
	const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
	if (jsonMatch && jsonMatch[1]) {
		cleaned = jsonMatch[1].trim()
	} else {
		// Try to find the first { and last }
		const startIdx = cleaned.indexOf('{')
		const endIdx = cleaned.lastIndexOf('}')
		if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
			cleaned = cleaned.substring(startIdx, endIdx + 1)
		}
	}

	// Step 2: Parse JSON
	let parsed: { tasks?: unknown[] }
	try {
		parsed = JSON.parse(cleaned)
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e)
		return { success: false, errors: [`Invalid JSON: ${message}`] }
	}

	// Step 3: Validate schema
	const errors: string[] = []
	const tasks = parsed.tasks

	if (!Array.isArray(tasks)) {
		return { success: false, errors: ['Expected { "tasks": [...] } at top level'] }
	}

	if (tasks.length === 0) {
		return { success: false, errors: ['Task list is empty'] }
	}

	if (tasks.length > 15) {
		errors.push(`Warning: ${tasks.length} tasks is a lot. Consider splitting into sessions.`)
	}

	const validatedTasks: AgentTask[] = []
	const seenIds = new Set<string>()

	for (let i = 0; i < tasks.length; i++) {
		const t = tasks[i] as Record<string, unknown>
		const prefix = `Task ${i + 1}`

		if (!t.id || typeof t.id !== 'string') {
			errors.push(`${prefix}: missing or invalid "id"`)
			continue
		}
		if (seenIds.has(t.id)) {
			errors.push(`${prefix}: duplicate id "${t.id}"`)
			continue
		}
		if (!t.title || typeof t.title !== 'string') {
			errors.push(`${prefix}: missing "title"`)
			continue
		}
		if (!t.description || typeof t.description !== 'string') {
			errors.push(`${prefix}: missing "description"`)
			continue
		}
		if (!Array.isArray(t.targetFiles)) {
			errors.push(`${prefix}: "targetFiles" must be an array (can be empty)`)
			continue
		}
		if (t.targetFiles.length > 3) {
			errors.push(`${prefix}: "${t.title}" touches ${t.targetFiles.length} files. Max is 3.`)
			// Soft error — warn but allow
		}

		// Check dependency IDs exist (check against already-seen IDs)
		const deps: string[] = Array.isArray(t.dependsOn) ? t.dependsOn as string[] : []
		for (const dep of deps) {
			if (!seenIds.has(dep)) {
				errors.push(`${prefix}: depends on "${dep}" which either doesn't exist or comes after this task`)
			}
		}

		seenIds.add(t.id)
		validatedTasks.push({
			id: t.id,
			title: t.title,
			description: t.description,
			targetFiles: t.targetFiles as string[],
			dependsOn: deps,
			taskType: (t.taskType === 'create' || t.taskType === 'modify' || t.taskType === 'refactor')
				? t.taskType
				: 'modify',
			status: 'pending'
		})
	}

	// Hard errors (missing id, title, files) block import
	const hardErrors = errors.filter(e => !e.startsWith('Warning:'))
	if (hardErrors.length > 0) {
		return { success: false, errors }
	}

	// Soft errors (warnings) allow import but display
	return { success: true, tasks: validatedTasks, errors: errors.length > 0 ? errors : undefined }
}


// ======================== Plan Validation ========================

/**
 * Validates a plan's structural integrity.
 * Used after inline editing and after import.
 */
export function validatePlan(tasks: AgentTask[]): string[] {
	const errors: string[] = []
	const seenIds = new Set<string>()

	for (let i = 0; i < tasks.length; i++) {
		const task = tasks[i]
		const prefix = `Task ${i + 1} ("${task.title}")`

		if (!task.id) {
			errors.push(`${prefix}: missing id`)
		}
		if (seenIds.has(task.id)) {
			errors.push(`${prefix}: duplicate id "${task.id}"`)
		}
		seenIds.add(task.id)

		if (!task.title) {
			errors.push(`${prefix}: missing title`)
		}
		if (!task.description) {
			errors.push(`${prefix}: missing description`)
		}
		if (task.targetFiles.length === 0 && task.taskType !== 'explore') {
			errors.push(`${prefix}: no target files`)
		}
		if (task.targetFiles.length > 3) {
			errors.push(`${prefix}: touches ${task.targetFiles.length} files (max 3)`)
		}

		// Check dependencies reference valid, earlier tasks
		for (const dep of task.dependsOn) {
			if (!seenIds.has(dep)) {
				errors.push(`${prefix}: depends on "${dep}" which doesn't exist or comes later`)
			}
		}
	}

	return errors
}


// ======================== Task Auto-Splitting ========================

/**
 * Post-processing: if any task touches >3 files, split it into sub-tasks.
 */
export function autoSplitOversizedTasks(tasks: AgentTask[]): AgentTask[] {
	return tasks.flatMap(task => {
		if (task.targetFiles.length <= 3) {
			return [task]
		}

		// Split into sub-tasks grouped by 2 files each
		const subTasks: AgentTask[] = []
		for (let i = 0; i < task.targetFiles.length; i += 2) {
			const chunk = task.targetFiles.slice(i, i + 2)
			subTasks.push({
				...task,
				id: `${task.id}_part${Math.floor(i / 2) + 1}`,
				title: `${task.title} (part ${Math.floor(i / 2) + 1})`,
				targetFiles: chunk,
				dependsOn: i === 0 ? task.dependsOn : [`${task.id}_part${Math.floor(i / 2)}`],
			})
		}
		return subTasks
	})
}
