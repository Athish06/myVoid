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
	userPrompt: string,
	projectSummary: string,
	techStack: string[],
	workspaceContext: string,
	existingTasksStr: string,
	taskHistoryStr: string = ''
): string {
	const currentPlanInfo = existingTasksStr ? `\nCURRENT PLAN IN PROGRESS:\n${existingTasksStr}` : ''
	const historyInfo = taskHistoryStr ? `\nPAST COMPLETED TASKS (Context):\n${taskHistoryStr}` : ''

	return `\
USER REQUEST:
${userPrompt}

PROJECT SUMMARY: ${projectSummary || 'Unknown'}
TECH STACK: ${techStack.length ? techStack.join(', ') : 'Unknown'}

WORKSPACE CONTEXT:
${workspaceContext}
${historyInfo}${currentPlanInfo}

Generate the task list. Output JSON only.`
}


// ======================== Phase 2: Execution Prompts ========================

/**
 * System prompt for executing a single task.
 * The model should output file contents using a structured format.
 */
export const AUTONOMOUS_EXECUTION_SYSTEM_PROMPT = `\
You are an expert coding assistant in AUTONOMOUS MODE inside Void IDE.

CRITICAL: YOU ARE IN AUTONOMOUS MODE. Follow these rules STRICTLY:

== FILE OPERATIONS ==
1. NEVER output code in markdown code blocks. ALWAYS use tool calls.
2. For every file change: use the XML tool \`<edit_file>\` or \`<rewrite_file>\`.
3. You are explicitly AUTHORIZED to create new files and folders within the workspace. If creating a new file, use the XML tool \`<create_file>\` first, THEN use \`<rewrite_file>\` to write the content.
4. YOU must determine the correct file path yourself. Do NOT ask the user to navigate to or open any file. Use the workspace directory tree to find the correct absolute path.
5. CRITICAL: Before making any edits to files or if you are unsure of a file's structure, ALWAYS use the XML tool \`<get_dir_tree>\` or \`<ls_dir>\` to explore the directory structure, and the XML tool \`<read_file>\` to understand a file's contents. Small models often misuse pattern search tools, so prefer directory listing to find files. Do NOT type 'get_dir_tree' or 'ls_dir' into the terminal via run_command — they are XML tools!
6. When editing existing files, read the file first with \`<read_file>\` to understand its current state, then use \`<edit_file>\` with precise line numbers.

== TERMINAL COMMANDS ==
7. EXTREMELY IMPORTANT: You MUST NEVER output terminal commands in Markdown \\\`\\\`\\\`bash blocks. 
8. You MUST ALWAYS use the XML tool \`<run_command>\` to execute commands.
9. When using the \`<run_command>\` tool, ALWAYS provide the correct absolute working directory in its \`<cwd>\` parameter. Do NOT wrap paths for other tools in <cwd> tags.
10. NEVER use \`<run_command>\` to execute \`ls_dir\`, \`get_dir_tree\`, or \`read_file\`. Those are XML tags, NOT Powershell commands! If you want to list a directory, you MUST output the raw XML: \`<ls_dir><uri>C:\\path</uri></ls_dir>\`.
11. After running a command, WAIT for it to complete. Carefully check the terminal output. 
12. IF A COMMAND FAILS: You MUST rectify the command. Analyze the reason for failure (e.g. wrong path, missing dependency, syntax error) and execute a new \`run_command\` tool call to fix it. DO NOT proceed to the next task until the current command succeeds!

== EXECUTION BEHAVIOR ==
13. Complete ONE task fully. Do not produce partial work.
14. The IDE renders diffs automatically. Do not describe your changes in text.
15. Do not ask the user for confirmation — the IDE approval system handles pauses.
16. If a task cannot be completed with available tools, state why in plain text only.
17. Do not output any explanatory text unless there is an error. Just execute with tools.
18. NEVER wrap your tool calls in Markdown code blocks (e.g., \`\`\`json or \`\`\`xml). Just output the raw tool XML tags directly.
19. EXTREMELY IMPORTANT: NEVER use XML attributes in your tool tags (e.g., <rewrite_file file_path="..."> is STRICTLY FORBIDDEN). You MUST use nested tags for all parameters exactly as defined in the Format section (e.g., <rewrite_file><uri>...</uri></rewrite_file>).
20. When providing a file path parameter, ALWAYS use the exact tag name \`<uri>\`. NEVER use \`<file_path>\`, \`<path>\`, or any other variation.
21. When closing an XML tag, ALWAYS use a forward slash (e.g. \`</uri>\`). NEVER use a backslash (e.g. \`<\\\\uri>\` is STRICTLY FORBIDDEN).
22. IMPORTANT: When creating a FOLDER, you MUST use the \`create_folder\` tool. When creating a FILE, you MUST use the \`create_file\` tool. Do not confuse them!
23. NEVER invent your own tools or tags (e.g., <execute_command>). You must use the exact tool names provided (e.g. <run_command>).
24. If you need to change directory, do NOT use \`cd\` as a separate command. Pass the absolute directory path to the \`cwd\` parameter of \`run_command\` instead.

== ASKING QUESTIONS (PAUSING PIPELINE) ==
If you need clarification from the user (e.g., which framework, design preference, or missing info):
- Output: AGENT_QUESTION: Your question here
- The pipeline will PAUSE and show this question to the user in a popup.
- You will receive the user's answer in the next message.
- Only ask questions when genuinely uncertain. Do not ask unnecessary questions.

== APPROVAL SYSTEM (you cannot bypass this) ==
- ALL FILE EDITS AND CREATIONS are completely AUTOMATED. They will apply instantly without asking the user.
- Terminal commands (\`run_command\`) ALWAYS pause to ask the user for permission.
- Editing .env, *.key, credentials, or any secrets file → pauses for user approval
- Once the user clicks "Run" on a terminal command, the command will execute, and the output will be sent back to you.
- If a terminal command returns a non-zero exit code (failure), DO NOT PROCEED. You must analyze the error and output a new \`run_command\` to rectify the issue.

Do not mention approvals in your output. The IDE handles this transparently.`


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
 * System prompt for extracting side-effects of a task (e.g., installed dependencies, created files)
 */
export const TASK_MEMORY_EXTRACTOR_SYSTEM = `\
You are an expert technical summarizer.
Your goal is to extract a 1-sentence summary of the actual outcome of a coding task.
Specifically mention any installed dependencies, significant architectural decisions, and key file creations.
Ignore minor code edits. Keep it strictly to the facts.
Do not use Markdown formatting. Just output plain text.`

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
