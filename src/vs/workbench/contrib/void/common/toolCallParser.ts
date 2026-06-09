/*--------------------------------------------------------------------------------------
 * Tool Call Parser — deterministic extraction from agent XML output.
 * Called AFTER a task completes to update session state.
 *
 * This file is the backbone of the deterministic memory layer.
 * It parses raw XML tool calls from the agent's assistant messages
 * to extract exact file paths, packages installed, and commands run.
 * No LLM involved — zero hallucination risk.
 *--------------------------------------------------------------------------------------*/

import { InstalledPackage } from './agentPipelineTypes.js'

export interface ParsedToolCalls {
	filesCreated: string[]
	filesModified: string[]
	packagesInstalled: InstalledPackage[]
	commandsRun: string[]
}

/**
 * Parse all tool calls from a block of text (typically agent assistant messages joined).
 * Handles <create_file>, <rewrite_file>, <edit_file>, <run_command>.
 */
export function parseToolCallsFromText(text: string, taskId: string): ParsedToolCalls {
	const filesCreated: string[] = []
	const filesModified: string[] = []
	const commandsRun: string[] = []
	const packagesInstalled: InstalledPackage[] = []

	// --- File created: <create_file><uri>PATH</uri>...</create_file>
	const createFileRe = /<create_file>[\s\S]*?<uri>\s*([\s\S]*?)\s*<\/uri>/g
	let m: RegExpExecArray | null
	while ((m = createFileRe.exec(text)) !== null) {
		const p = m[1].trim()
		if (p) filesCreated.push(p)
	}

	// --- File rewritten: <rewrite_file><uri>PATH</uri>...
	const rewriteFileRe = /<rewrite_file>[\s\S]*?<uri>\s*([\s\S]*?)\s*<\/uri>/g
	while ((m = rewriteFileRe.exec(text)) !== null) {
		const p = m[1].trim()
		if (p && !filesCreated.includes(p)) filesModified.push(p)
	}

	// --- File edited: <edit_file><uri>PATH</uri>...
	const editFileRe = /<edit_file>[\s\S]*?<uri>\s*([\s\S]*?)\s*<\/uri>/g
	while ((m = editFileRe.exec(text)) !== null) {
		const p = m[1].trim()
		if (p && !filesCreated.includes(p) && !filesModified.includes(p)) filesModified.push(p)
	}

	// --- Commands: <run_command>...<cwd>...</cwd>...</run_command>
	const runCommandRe = /<run_command>([\s\S]*?)<\/run_command>/g
	while ((m = runCommandRe.exec(text)) !== null) {
		const inner = m[1]
		// Extract the <command> tag content, or fallback to stripping <cwd>
		const cmdTagMatch = inner.match(/<command>\s*([\s\S]*?)\s*<\/command>/)
		const cmd = cmdTagMatch
			? cmdTagMatch[1].trim()
			: inner.replace(/<cwd>[\s\S]*?<\/cwd>/g, '').trim()
		if (cmd) {
			commandsRun.push(cmd)
			_extractPackages(cmd, taskId, packagesInstalled)
		}
	}

	return {
		filesCreated: [...new Set(filesCreated)],
		filesModified: [...new Set(filesModified)],
		packagesInstalled,
		commandsRun,
	}
}

/**
 * Parse npm / pip / cargo install commands and append to the packages list.
 * Handles: `npm install X Y Z`, `npm i X`, `pip install X`, `pip3 install X`,
 *           `cargo add X`, `npm install --save-dev X`.
 */
function _extractPackages(
	cmd: string,
	taskId: string,
	out: InstalledPackage[]
): void {
	// npm install / npm i / npm add
	const npmRe = /npm\s+(?:install|i|add)\s+((?:(?!--)[^\s]+\s*)+)/g
	let m: RegExpExecArray | null
	while ((m = npmRe.exec(cmd)) !== null) {
		const tokens = m[1].trim().split(/\s+/)
		for (const tok of tokens) {
			if (!tok.startsWith('-') && tok.length > 0) {
				const name = tok.split('@')[0] || tok
				if (name) out.push({ manager: 'npm', name, taskId })
			}
		}
	}

	// pip install / pip3 install
	const pipRe = /pip3?\s+install\s+((?:(?!--)[^\s]+\s*)+)/g
	while ((m = pipRe.exec(cmd)) !== null) {
		const tokens = m[1].trim().split(/\s+/)
		for (const tok of tokens) {
			if (!tok.startsWith('-') && tok.length > 0) {
				const name = tok.split('==')[0] || tok
				if (name) out.push({ manager: 'pip', name, taskId })
			}
		}
	}

	// cargo add
	const cargoRe = /cargo\s+add\s+((?:(?!--)[^\s]+\s*)+)/g
	while ((m = cargoRe.exec(cmd)) !== null) {
		const tokens = m[1].trim().split(/\s+/)
		for (const tok of tokens) {
			if (!tok.startsWith('-') && tok.length > 0) {
				out.push({ manager: 'cargo', name: tok, taskId })
			}
		}
	}
}

/**
 * Build a compact one-line summary string from the parsed outcome.
 * Used as the human-readable task summary in session state and context injection.
 * Example: "Created user.model.ts, auth.service.ts; installed bcrypt, jsonwebtoken"
 */
export function buildTaskSummary(
	taskTitle: string,
	parsed: ParsedToolCalls
): string {
	const parts: string[] = [taskTitle]
	if (parsed.filesCreated.length > 0) {
		const names = parsed.filesCreated.map(f => f.split(/[\\/]/).pop() || f)
		parts.push(`created: ${names.join(', ')}`)
	}
	if (parsed.filesModified.length > 0) {
		const names = parsed.filesModified.map(f => f.split(/[\\/]/).pop() || f)
		parts.push(`modified: ${names.join(', ')}`)
	}
	if (parsed.packagesInstalled.length > 0) {
		const deduped = [...new Set(parsed.packagesInstalled.map(p => p.name))]
		parts.push(`installed: ${deduped.join(', ')}`)
	}
	return parts.join('; ')
}
