/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { AgentPlan, AgentTask } from './agentPipelineTypes.js'

// ======================== Phase 1: Planning Prompts ========================

/**
 * System prompt for refining the user's raw prompt into a structured plan request.
 * Input: raw user prompt + workspace context
 * Output: JSON with { refinedPrompt, projectSummary, techStack }
 */
export const PROMPT_REFINER_SYSTEM = `\
You are a coding project planner. Your job is to take a user's request and refine it into a clear, actionable specification.

You will be given:
1. The user's raw request
2. Information about their workspace (file structure, open files, etc.)

Output ONLY valid JSON in this exact schema (no other text, no markdown fences):
{
  "refinedPrompt": "A clear, detailed description of exactly what needs to be built or changed. Include specifics about files, patterns, and requirements.",
  "projectSummary": "One-line summary of the project/workspace",
  "techStack": ["list", "of", "technologies", "detected"]
}

Rules:
- The refinedPrompt should be 2-5 sentences, much more specific than the user's raw input
- Detect the tech stack from the workspace file structure (package.json, requirements.txt, etc.)
- If the user's request is vague, make reasonable assumptions and state them in the refinedPrompt
- Output JSON only. No explanation, no markdown.`


/**
 * Builds the user message for prompt refinement.
 */
export function buildPromptRefinerUserMessage(rawPrompt: string, workspaceContext: string): string {
	return `\
USER REQUEST:
${rawPrompt}

WORKSPACE CONTEXT:
${workspaceContext}

Refine this into a structured specification. Output JSON only.`
}


/**
 * System prompt for generating the task list from a refined prompt.
 * Input: refined prompt + project context
 * Output: JSON with { tasks: AgentTask[] }
 */
export const TASK_GENERATOR_SYSTEM = `\
You are a coding task planner. Your job is to break down a refined specification into an ordered list of atomic coding tasks.

Output ONLY valid JSON in this exact schema (no other text, no markdown fences):
{
  "tasks": [
    {
      "id": "task_001",
      "title": "Short action title (e.g. Create user model)",
      "description": "Detailed description of exactly what to do in this task. Be specific about what code to write.",
      "targetFiles": ["path/to/file.ts"],
      "dependsOn": [],
      "taskType": "create"
    }
  ]
}

Rules:
- Maximum 10 tasks total
- Each task touches at most 3 files
- Tasks must be ordered by dependency (no task can depend on a later task)
- If a task would exceed 400 characters in description, split it into 2+ tasks
- If a task requires creating AND modifying the same file, that is 2 separate tasks
- taskType is one of: "create", "modify", "refactor"
- dependsOn references task IDs that must complete before this task
- Use full file paths relative to workspace root
- Output JSON only. No explanation, no markdown.`


/**
 * Builds the user message for task generation.
 */
export function buildTaskGeneratorUserMessage(
	refinedPrompt: string,
	projectSummary: string,
	techStack: string[],
	directoryStr: string
): string {
	return `\
REFINED SPECIFICATION:
${refinedPrompt}

PROJECT: ${projectSummary}
STACK: ${techStack.join(', ')}

FILE STRUCTURE:
${directoryStr}

Break this down into ordered, atomic coding tasks. Output JSON only.`
}


// ======================== Phase 2: Execution Prompts ========================

/**
 * System prompt for executing a single task.
 * The model should output file contents using a structured format.
 */
export const TASK_EXECUTION_SYSTEM = `\
You are an expert coding agent executing a specific task from a plan.
You have access to the same tools as a normal coding agent (read_file, edit_file, create_file_or_folder, run_command, etc.).

Important context about your current task:
- You are executing ONE task from a larger plan
- Previous tasks may have already created or modified files
- Future tasks will handle other parts of the plan
- Focus ONLY on your current task. Do not do work belonging to other tasks.

Guidelines:
1. Read any files you need to understand before making changes
2. Use edit_file for modifications, create_file_or_folder + rewrite_file for new files
3. Make changes that are consistent with the existing codebase style
4. When done, briefly summarize what you did`


/**
 * Builds the full execution prompt for a task, including memory context and plan position.
 */
export function buildTaskExecutionPrompt(
	task: AgentTask,
	plan: AgentPlan,
	memoryContext: string,
): string {

	const completedTasks = plan.tasks.filter(t => t.status === 'done')
	const upcomingTasks = plan.tasks
		.filter(t => t.status === 'pending' && t.id !== task.id)
		.slice(0, 3) // show next 3 tasks as lookahead

	const parts: string[] = []

	// Memory context (project summary, decisions, recent work)
	if (memoryContext) {
		parts.push(memoryContext)
	}

	// Plan position — helps the model understand what's been done and what's coming
	parts.push(`PLAN CONTEXT:
Completed tasks: ${completedTasks.map(t => `[✓] ${t.title}`).join(' | ') || 'none yet'}
Upcoming tasks: ${upcomingTasks.map(t => `[ ] ${t.title}`).join(' | ') || 'this is the last task'}`)

	// Current task details
	parts.push(`CURRENT TASK: ${task.title}
DESCRIPTION: ${task.description}
TARGET FILES: ${task.targetFiles.join(', ')}`)

	return parts.join('\n\n')
}


// ======================== Re-Planning Prompts ========================

/**
 * System prompt for re-planning after repeated task failures.
 */
export const REPLAN_SYSTEM_PROMPT = `\
You are fixing a failed coding task.
The original task did not work. Analyze the error and the actual file state,
then output 1-3 replacement tasks that achieve the same goal differently.

Rules:
- Be more conservative than the original tasks
- Each replacement task touches only ONE file
- Explain what went wrong in "diagnosis"

Output JSON only (no markdown fences, no explanation).
Schema: {
  "diagnosis": "string explaining what went wrong",
  "replacementTasks": [{
    "id": "task_XXX_retry",
    "title": "string",
    "description": "string",
    "targetFiles": ["string"],
    "dependsOn": [],
    "taskType": "create | modify | refactor"
  }]
}`


/**
 * Builds the user message for re-planning a failed task.
 */
export function buildReplanUserMessage(
	task: AgentTask,
	lastError: string,
	fileStateAtFailure: Record<string, string>,
	affectedTasks: AgentTask[]
): string {
	const fileStateStr = Object.entries(fileStateAtFailure)
		.map(([f, c]) => `${f}:\n${c.slice(0, 500)}...`)
		.join('\n---\n')

	return `\
FAILED TASK: ${task.title}
DESCRIPTION: ${task.description}
TARGET FILES: ${task.targetFiles.join(', ')}

ERROR THAT OCCURRED:
${lastError}

ACTUAL FILE STATE AT TIME OF FAILURE:
${fileStateStr}

DOWNSTREAM TASKS THAT ALSO NEED REPLACEMENT:
${affectedTasks.map(t => `- ${t.id}: ${t.title}`).join('\n')}

Provide replacement tasks. Output JSON only.`
}


// ======================== Memory Extraction ========================

/**
 * System prompt for extracting memory entries from a completed task.
 * Runs after each task to capture decisions, patterns, and file descriptions.
 */
export const MEMORY_EXTRACTION_SYSTEM = `\
You are a memory extractor. After a coding task completes, extract key facts worth remembering.

Output ONLY valid JSON (no markdown fences):
{
  "entries": [
    {
      "text": "Short fact worth remembering (1 sentence)",
      "type": "decision | fix | architecture | file_created | pattern"
    }
  ],
  "fileDescriptions": {
    "path/to/file.ts": "One-line description of what this file does"
  }
}

Rules:
- Extract 0-3 entries. Only extract genuinely useful facts.
- "decision" = architectural or design choice made
- "fix" = a bug that was found and how it was fixed
- "architecture" = structural pattern established
- "file_created" = a new file and its purpose
- "pattern" = a code pattern used (naming convention, import style, etc.)
- fileDescriptions: only for files that were created or significantly changed
- Output JSON only.`

export function buildMemoryExtractionUserMessage(
	task: AgentTask,
	taskResult: string
): string {
	return `\
COMPLETED TASK: ${task.title}
DESCRIPTION: ${task.description}
FILES TOUCHED: ${task.targetFiles.join(', ')}

RESULT:
${taskResult}

Extract memory entries and file descriptions. Output JSON only.`
}
