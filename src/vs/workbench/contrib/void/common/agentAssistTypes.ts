/*--------------------------------------------------------------------------------------
 *  Agent Assist Service Types
 *  Defines all types for the middleware layer that intercepts, validates, repairs,
 *  and translates tool calls before they reach the execution engine.
 *--------------------------------------------------------------------------------------*/

import { RawToolParamsObj } from './sendLLMMessageTypes.js'

/** A single repair that the Assist Service applied to a tool call */
export interface RepairEntry {
	type: 'param_rename' | 'path_normalize' | 'tag_fix' | 'command_translate' | 'tool_reroute' | 'cwd_strip' | 'markdown_strip' | 'search_replace_fix' | 'param_extract'
	description: string
	before: string
	after: string
}

/** The structured result returned after the Assist Service processes a tool call */
export interface AssistResult {
	/** The corrected tool name (e.g., 'execute_command' → 'run_command') */
	toolName: string
	/** The corrected, normalized parameters */
	params: RawToolParamsObj
	/** Array of repairs that were applied (for logging/UI) */
	repairs: RepairEntry[]
	/** Whether the call was intercepted and rerouted (e.g., run_command of 'ls_dir' → native ls_dir) */
	wasIntercepted: boolean
	/** Whether the call should be blocked entirely */
	blocked: boolean
	blockReason?: string
	/** If set, signals that the file at this path must be read before editing (read-before-edit enforcement) */
	requiresReadFirst?: string
}

/** Shell translation result */
export interface ShellTranslation {
	original: string
	translated: string
	wasTranslated: boolean
	warnings: string[]
}
