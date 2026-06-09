/*--------------------------------------------------------------------------------------
 *  Agent Assist Service
 *  Middleware that intercepts, validates, repairs, and translates every tool call
 *  the LLM agent produces BEFORE it reaches the execution engine.
 *
 *  This service silently fixes broken tool calls from small (7B) models so the
 *  pipeline never crashes due to hallucinated syntax, wrong parameters, or
 *  shell-incompatible commands.
 *--------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js'
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js'
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js'
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js'
import { RawToolParamsObj } from '../common/sendLLMMessageTypes.js'
import { AssistResult, RepairEntry } from '../common/agentAssistTypes.js'
import { os } from '../common/helpers/systemInfo.js'
import { ORIGINAL, DIVIDER, FINAL } from '../common/prompt/prompts.js'


// ======================== Service Interface ========================

export interface IAgentAssistService {
	readonly _serviceBrand: undefined

	/**
	 * The single entry point. Called from chatThreadService._runToolCall()
	 * right before parameter validation.
	 *
	 * Takes the raw tool name and raw params from extractGrammar.ts,
	 * applies all repairs, and returns the corrected tool call.
	 */
	processToolCall(toolName: string, rawParams: RawToolParamsObj): AssistResult
}

export const IAgentAssistService = createDecorator<IAgentAssistService>('AgentAssistService')


// ======================== Tool Name Aliases ========================

/** Maps hallucinated tool names to their correct canonical names */
const TOOL_NAME_ALIASES: Record<string, string> = {
	'execute_command': 'run_command',
	'list_dir': 'ls_dir',
	'list_directory': 'ls_dir',
	'dir': 'ls_dir',
	'find_files': 'search_pathnames_only',
	'find': 'search_pathnames_only',
	'write_file': 'rewrite_file',
	'modify_file': 'edit_file',
	'update_file': 'edit_file',
	'make_file': 'create_file',
	'new_file': 'create_file',
	'make_dir': 'create_folder',
	'mkdir': 'create_folder',
	'make_folder': 'create_folder',
	'new_folder': 'create_folder',
	'remove_file': 'delete_file_or_folder',
	'rm_file': 'delete_file_or_folder',
	'delete_file': 'delete_file_or_folder',
	'delete_folder': 'delete_file_or_folder',
	'remove_folder': 'delete_file_or_folder',
	'grep': 'search_for_files',
	'search': 'search_for_files',
	'cat': 'read_file',
	'view_file': 'read_file',
	'show_file': 'read_file',
	'tree': 'get_dir_tree',
	'dir_tree': 'get_dir_tree',
	'directory_tree': 'get_dir_tree',
}


// ======================== Parameter Aliases ========================

/** Maps hallucinated param names to their correct canonical names, per-tool */
const PARAM_ALIASES: Record<string, Record<string, string>> = {
	// URI aliases (apply to most tools)
	'_global_uri': {
		'file_path': 'uri',
		'filepath': 'uri',
		'path': 'uri',
		'file': 'uri',
		'directory': 'uri',
		'folder': 'uri',
		'dir': 'uri',
		'filename': 'uri',
		'target': 'uri',
		'location': 'uri',
	},
	// rewrite_file specific
	'rewrite_file': {
		'content': 'new_content',
		'file_content': 'new_content',
		'code': 'new_content',
		'body': 'new_content',
		'text': 'new_content',
		'data': 'new_content',
	},
	// edit_file specific
	'edit_file': {
		'searchReplaceBlocks': 'search_replace_blocks',
		'blocks': 'search_replace_blocks',
		'changes': 'search_replace_blocks',
		'edits': 'search_replace_blocks',
		'diff': 'search_replace_blocks',
		'patches': 'search_replace_blocks',
	},
	// run_command specific
	'run_command': {
		'arguments': 'command',
		'args': 'command',
		'cmd': 'command',
		'exec': 'command',
		'script': 'command',
		'working_dir': 'cwd',
		'working_directory': 'cwd',
		'workdir': 'cwd',
	},
	// search tools
	'_global_search': {
		'search_query': 'query',
		'pattern': 'query',
		'text': 'query',
		'search': 'query',
		'term': 'query',
	},
	// persistent terminal
	'_global_terminal': {
		'terminal_id': 'persistent_terminal_id',
		'terminalId': 'persistent_terminal_id',
		'id': 'persistent_terminal_id',
	},
	// delete
	'delete_file_or_folder': {
		'recursive': 'is_recursive',
		'recurse': 'is_recursive',
	},
}


// ======================== Shell Command Translation ========================

/** Linux → PowerShell command translations (only used on Windows) */
const SHELL_TRANSLATIONS: Array<{
	pattern: RegExp
	translate: (match: RegExpMatchArray) => string
	warning?: string
}> = [
	// rm -rf <path>
	{
		pattern: /^rm\s+(-rf|-r\s+-f|-f\s+-r)\s+(.+)$/i,
		translate: (m) => `Remove-Item -Recurse -Force ${m[2]}`,
	},
	// rm -r <path>
	{
		pattern: /^rm\s+-r\s+(.+)$/i,
		translate: (m) => `Remove-Item -Recurse ${m[1]}`,
	},
	// rm <file> (simple)
	{
		pattern: /^rm\s+([^-].+)$/i,
		translate: (m) => `Remove-Item ${m[1]}`,
	},
	// cat <file>
	{
		pattern: /^cat\s+(.+)$/i,
		translate: (m) => `Get-Content ${m[1]}`,
	},
	// ls -la or ls -l or ls -a
	{
		pattern: /^ls\s+(-[la]+)\s*(.*)$/i,
		translate: (m) => `Get-ChildItem -Force ${m[2] || ''}`.trim(),
	},
	// ls (plain)
	{
		pattern: /^ls\s*$/i,
		translate: () => `Get-ChildItem`,
	},
	// ls <path>
	{
		pattern: /^ls\s+([^-].+)$/i,
		translate: (m) => `Get-ChildItem ${m[1]}`,
	},
	// mkdir -p <path>
	{
		pattern: /^mkdir\s+-p\s+(.+)$/i,
		translate: (m) => `New-Item -ItemType Directory -Force -Path ${m[1]}`,
	},
	// mkdir <path>
	{
		pattern: /^mkdir\s+(.+)$/i,
		translate: (m) => `New-Item -ItemType Directory -Path ${m[1]}`,
	},
	// cp -r <src> <dst>
	{
		pattern: /^cp\s+-r\s+(\S+)\s+(\S+)$/i,
		translate: (m) => `Copy-Item -Recurse ${m[1]} ${m[2]}`,
	},
	// cp <src> <dst>
	{
		pattern: /^cp\s+(\S+)\s+(\S+)$/i,
		translate: (m) => `Copy-Item ${m[1]} ${m[2]}`,
	},
	// mv <src> <dst>
	{
		pattern: /^mv\s+(\S+)\s+(\S+)$/i,
		translate: (m) => `Move-Item ${m[1]} ${m[2]}`,
	},
	// grep <pattern> <file>
	{
		pattern: /^grep\s+(?:-[a-zA-Z]*\s+)*["']?([^"'\s]+)["']?\s+(.+)$/i,
		translate: (m) => `Select-String -Pattern "${m[1]}" ${m[2]}`,
	},
	// touch <file>
	{
		pattern: /^touch\s+(.+)$/i,
		translate: (m) => `New-Item -ItemType File -Path ${m[1]} -Force`,
	},
	// pwd
	{
		pattern: /^pwd\s*$/i,
		translate: () => `Get-Location`,
	},
	// echo "text" > file
	{
		pattern: /^echo\s+["']?(.+?)["']?\s*>\s*(\S+)$/i,
		translate: (m) => `Set-Content -Path ${m[2]} -Value "${m[1]}"`,
	},
	// echo "text" >> file
	{
		pattern: /^echo\s+["']?(.+?)["']?\s*>>\s*(\S+)$/i,
		translate: (m) => `Add-Content -Path ${m[2]} -Value "${m[1]}"`,
	},
	// which <cmd>
	{
		pattern: /^which\s+(.+)$/i,
		translate: (m) => `Get-Command ${m[1]}`,
	},
	// export VAR=val
	{
		pattern: /^export\s+(\w+)=["']?(.+?)["']?\s*$/i,
		translate: (m) => `$env:${m[1]} = "${m[2]}"`,
	},
	// source <file>
	{
		pattern: /^source\s+(.+)$/i,
		translate: (m) => `. ${m[1]}`,
	},
	// clear
	{
		pattern: /^clear\s*$/i,
		translate: () => `Clear-Host`,
	},
	// chmod (no-op on Windows)
	{
		pattern: /^chmod\s+.+$/i,
		translate: (m) => `Write-Host "chmod is not supported on Windows, skipping: ${m[0]}"`,
		warning: 'chmod has no effect on Windows',
	},
	// python3 -> python (often python3 doesn't exist on windows)
	{
		pattern: /^python3\s*(.*)$/i,
		translate: (m) => `python ${m[1] || ''}`.trim(),
	},
	// chown (no-op on Windows)
	{
		pattern: /^chown\s+.+$/i,
		translate: (m) => `Write-Host "chown is not supported on Windows, skipping: ${m[0]}"`,
		warning: 'chown has no effect on Windows',
	},
]


// ======================== Tool-Within-Tool Detection ========================

/** XML tool names that are NOT terminal commands */
const XML_ONLY_TOOLS = new Set([
	'ls_dir', 'get_dir_tree', 'read_file',
	'search_for_files', 'search_pathnames_only',
	'search_in_file', 'read_lint_errors',
	'create_file', 'create_folder', 'edit_file',
	'rewrite_file', 'delete_file_or_folder',
])

/** Terminal commands that should be rerouted to XML tools */
const TERMINAL_TO_XML_REROUTES: Array<{
	pattern: RegExp
	xmlTool: string
	extractParams: (match: RegExpMatchArray, cwd: string | null) => RawToolParamsObj
}> = [
	// cat <file> → read_file
	{
		pattern: /^(?:cat|type|more|head|tail)\s+["']?(.+?)["']?\s*$/i,
		xmlTool: 'read_file',
		extractParams: (m, cwd) => ({ uri: resolvePathArg(m[1], cwd) }),
	},
	// ls / dir → ls_dir
	{
		pattern: /^(?:ls|dir)\s*(?:-[a-zA-Z]+\s+)?["']?(.*)["']?\s*$/i,
		xmlTool: 'ls_dir',
		extractParams: (m, cwd) => ({ uri: m[1]?.trim() ? resolvePathArg(m[1].trim(), cwd) : (cwd || '') }),
	},
	// tree → get_dir_tree
	{
		pattern: /^tree\s*["']?(.*)["']?\s*$/i,
		xmlTool: 'get_dir_tree',
		extractParams: (m, cwd) => ({ uri: m[1]?.trim() ? resolvePathArg(m[1].trim(), cwd) : (cwd || '') }),
	},
	// grep <pattern> <file> → search_for_files
	{
		pattern: /^grep\s+(?:-[a-zA-Z]*\s+)*["']?([^"'\s]+)["']?\s+["']?(.+?)["']?\s*$/i,
		xmlTool: 'search_for_files',
		extractParams: (m) => ({ query: m[1] }),
	},
	// find → search_pathnames_only
	{
		pattern: /^find\s+.+-name\s+["']?(.+?)["']?\s*$/i,
		xmlTool: 'search_pathnames_only',
		extractParams: (m) => ({ query: m[1] }),
	},
	// rm / delete / remove → delete_file_or_folder
	{
		pattern: /^\s*(?:rm|delete|remove)\s+(?:-r\s+|-rf\s+|-f\s+)?["']?(.*?)(?:["']?\s+if\s+it\s+exists|\s*)$/i,
		xmlTool: 'delete_file_or_folder',
		extractParams: (m, cwd) => ({ uri: m[1]?.trim() ? resolvePathArg(m[1].trim(), cwd) : (cwd || '') }),
	},
]


// ======================== Helper Functions ========================

/** Resolve a possibly relative path argument against a cwd or workspace root */
function resolvePathArg(pathStr: string, cwd: string | null): string {
	if (!pathStr) return cwd || ''
	// Already absolute
	if (/^[A-Za-z]:[\\/]/.test(pathStr) || pathStr.startsWith('/')) {
		return pathStr
	}
	// Relative: resolve against cwd
	if (cwd) {
		const sep = cwd.includes('\\') ? '\\' : '/'
		const cleanPath = pathStr.replace(/^\.[\\/]/, '')
		return `${cwd.replace(/[\\/]$/, '')}${sep}${cleanPath}`
	}
	return pathStr
}

/** Strip rogue XML tags from a string value (e.g., <cwd>, </cwd>, <\cwd>) */
function stripRogueTags(value: string): string {
	return value
		.replace(/<cwd>|<\/cwd>|<\\cwd>/gi, '')
		.replace(/<uri>|<\/uri>|<\\uri>/gi, '')
		.replace(/<command>|<\/command>|<\\command>/gi, '')
		.trim()
}

/** Normalize a Windows path: fix double backslashes, mixed separators, strip quotes */
function normalizePath(pathStr: string, workspaceRoot: string | null): string {
	let p = pathStr
	// Strip surrounding quotes/backticks
	p = p.replace(/^["`']+|["`']+$/g, '')
	// Strip rogue XML tags
	p = stripRogueTags(p)
	// Replace forward slashes with backslashes on Windows for consistency
	if (os === 'windows' && /^[A-Za-z]:/.test(p)) {
		p = p.replace(/\//g, '\\')
	}
	// Fix double backslashes (but not UNC paths like \\server)
	if (os === 'windows') {
		p = p.replace(/([A-Za-z]:\\)\\+/g, '$1')
		p = p.replace(/\\{2,}/g, '\\')
	}
	// Resolve relative paths
	if (workspaceRoot && !(/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/'))) {
		const cleanPath = p.replace(/^\.[\\/]/, '')
		const sep = os === 'windows' ? '\\' : '/'
		p = `${workspaceRoot.replace(/[\\/]$/, '')}${sep}${cleanPath}`
	}
	// Strip trailing separator for files (not for directories that end with path sep)
	// Only strip if it looks like a file (has an extension)
	if (/\.\w+[\\/]$/.test(p)) {
		p = p.replace(/[\\/]$/, '')
	}
	return p.trim()
}


// ======================== Service Implementation ========================

class AgentAssistService extends Disposable implements IAgentAssistService {
	readonly _serviceBrand: undefined

	private readonly _workspaceRoot: string | null

	constructor(
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super()
		const folders = this._workspaceContextService?.getWorkspace?.()?.folders || []
		this._workspaceRoot = folders.length > 0 ? folders[0].uri.fsPath : null
	}

	/**
	 * Main entry point: processes a raw tool call and returns corrected version.
	 * Called from chatThreadService._runToolCall() before validateParams.
	 */
	processToolCall(toolName: string, rawParams: RawToolParamsObj): AssistResult {
		const repairs: RepairEntry[] = []
		let correctedName = toolName
		const correctedParams: RawToolParamsObj = { ...rawParams }
		let wasIntercepted = false
		let blocked = false
		let blockReason: string | undefined

		// ── Step 1: Tool Name Normalization ──
		correctedName = this._normalizeToolName(correctedName, repairs)

		// ── Step 2: Tool-Within-Tool Interception ──
		// If the agent is trying to run an XML tool as a terminal command
		if (correctedName === 'run_command') {
			const interception = this._interceptToolWithinTool(correctedParams, repairs)
			if (interception) {
				correctedName = interception.toolName
				// Replace params entirely
				for (const key of Object.keys(correctedParams)) {
					delete correctedParams[key]
				}
				Object.assign(correctedParams, interception.params)
				wasIntercepted = true
			}
		}

		// ── Step 2.5: Folder Correction Interception ──
		// If the agent uses create_file for a folder path
		if (correctedName === 'create_file' && typeof correctedParams.uri === 'string') {
			const uriStr = correctedParams.uri.trim()
			// If it has no extension AND matches common folder names, intercept it
			const hasNoExtension = !uriStr.includes('.') || uriStr.endsWith('/') || uriStr.endsWith('\\')
			const isCommonFolder = /(?:^|[\\/])(src|app|components|utils|services|controllers|models|routes|assets|database|config|backend|frontend|api|public|tests|node_modules|dist|build)$/i.test(uriStr)
			if (hasNoExtension && (isCommonFolder || uriStr.endsWith('/') || uriStr.endsWith('\\'))) {
				repairs.push({
					type: 'tool_reroute',
					description: `Intercepted create_file for folder → create_folder`,
					before: `create_file: ${uriStr}`,
					after: `create_folder: ${uriStr}`,
				})
				correctedName = 'create_folder'
				wasIntercepted = true
			}
		}

		// ── Step 3: Parameter Name Normalization ──
		this._normalizeParamNames(correctedName, correctedParams, repairs)

		// ── Step 4: Path Normalization ──
		this._normalizePaths(correctedParams, repairs)

		// ── Step 4.5: Command String Cleanup ──
		if (correctedName === 'run_command' || correctedName === 'run_persistent_command') {
			this._cleanCommandString(correctedParams, repairs)
		}

		// ── Step 5: CWD Sanitization ──
		if (correctedName === 'run_command' || correctedName === 'open_persistent_terminal') {
			this._sanitizeCwd(correctedParams, repairs)
		}

		// ── Step 6: Shell Command Translation (Windows only) ──
		if ((correctedName === 'run_command' || correctedName === 'run_persistent_command') && os === 'windows') {
			const cmdReroute = this._checkTerminalReroute(correctedParams, repairs)
			if (cmdReroute) {
				// Reroute to XML tool instead of running in terminal
				correctedName = cmdReroute.toolName
				for (const key of Object.keys(correctedParams)) {
					delete correctedParams[key]
				}
				Object.assign(correctedParams, cmdReroute.params)
				wasIntercepted = true
			} else {
				this._translateShellCommand(correctedParams, repairs)
			}
		}

		// ── Step 7: Command Validation ──
		if (correctedName === 'run_command' || correctedName === 'run_persistent_command') {
			const validation = this._validateRunCommand(correctedParams, repairs)
			if (validation.blocked) {
				blocked = true
				blockReason = validation.reason
			}
		}

		// ── Step 8: Search/Replace Block Validation ──
		if (correctedName === 'edit_file') {
			const validation = this._validateSearchReplaceBlocks(correctedParams, repairs)
			if (validation.blocked) {
				blocked = true
				blockReason = validation.reason
			}
		}

		return {
			toolName: correctedName,
			params: correctedParams,
			repairs,
			wasIntercepted,
			blocked,
			blockReason,
		}
	}


	// ======================== Step 1: Tool Name Normalization ========================

	private _normalizeToolName(toolName: string, repairs: RepairEntry[]): string {
		const canonical = TOOL_NAME_ALIASES[toolName]
		if (canonical) {
			repairs.push({
				type: 'tool_reroute',
				description: `Corrected tool name '${toolName}' → '${canonical}'`,
				before: toolName,
				after: canonical,
			})
			return canonical
		}
		return toolName
	}


	// ======================== Step 2: Tool-Within-Tool Interception ========================

	private _interceptToolWithinTool(
		params: RawToolParamsObj,
		repairs: RepairEntry[],
	): { toolName: string, params: RawToolParamsObj } | null {
		const command = (params.command as string || '').trim()
		if (!command) return null

		// Check if the agent typed an XML tool name as a terminal command
		// e.g., <run_command><command>ls_dir</command></run_command>
		const firstWord = command.split(/\s+/)[0]?.toLowerCase()
		if (firstWord && XML_ONLY_TOOLS.has(firstWord)) {
			// Extract path argument if any (everything after the tool name)
			const pathArg = command.substring(firstWord.length).trim()
			const cwd = (params.cwd as string) || this._workspaceRoot

			repairs.push({
				type: 'tool_reroute',
				description: `Intercepted '${firstWord}' from terminal → native XML tool`,
				before: `run_command: ${command}`,
				after: `${firstWord}: uri=${pathArg || cwd || ''}`,
			})

			const resolvedUri = pathArg ? normalizePath(pathArg, this._workspaceRoot) : (cwd || '')
			return {
				toolName: firstWord,
				params: { uri: resolvedUri },
			}
		}

		return null
	}


	// ======================== Step 3: Parameter Name Normalization ========================

	private _normalizeParamNames(
		toolName: string,
		params: RawToolParamsObj,
		repairs: RepairEntry[],
	): void {
		// Apply global URI aliases
		this._applyParamAliases(params, PARAM_ALIASES['_global_uri'] || {}, repairs)

		// Apply tool-specific aliases
		if (PARAM_ALIASES[toolName]) {
			this._applyParamAliases(params, PARAM_ALIASES[toolName], repairs)
		}

		// Apply global search aliases for search tools
		if (['search_for_files', 'search_pathnames_only', 'search_in_file'].includes(toolName)) {
			this._applyParamAliases(params, PARAM_ALIASES['_global_search'] || {}, repairs)
		}

		// Apply global terminal aliases for terminal tools
		if (['run_persistent_command', 'kill_persistent_terminal'].includes(toolName)) {
			this._applyParamAliases(params, PARAM_ALIASES['_global_terminal'] || {}, repairs)
		}
	}

	private _applyParamAliases(
		params: RawToolParamsObj,
		aliases: Record<string, string>,
		repairs: RepairEntry[],
	): void {
		for (const [alias, canonical] of Object.entries(aliases)) {
			if (params[alias] !== undefined && params[canonical] === undefined) {
				repairs.push({
					type: 'param_rename',
					description: `Renamed param '${alias}' → '${canonical}'`,
					before: alias,
					after: canonical,
				})
				params[canonical] = params[alias]
				delete params[alias]
			}
		}
	}


	// ======================== Step 4: Path Normalization ========================

	private _normalizePaths(
		params: RawToolParamsObj,
		repairs: RepairEntry[],
	): void {
		// Normalize the 'uri' parameter
		if (typeof params.uri === 'string' && params.uri.trim()) {
			const original = params.uri
			const normalized = normalizePath(params.uri, this._workspaceRoot)
			if (normalized !== original) {
				repairs.push({
					type: 'path_normalize',
					description: `Normalized path`,
					before: original,
					after: normalized,
				})
				params.uri = normalized
			}
		}
	}


	// ======================== Step 4.5: Command String Cleanup ========================

	private _cleanCommandString(
		params: RawToolParamsObj,
		repairs: RepairEntry[],
	): void {
		if (typeof params.command !== 'string') return
		
		let cmd = params.command

		// Check if the agent mistakenly put <cwd> inside the command tag
		const cwdMatch = cmd.match(/<cwd>\s*([\s\S]*?)\s*<\/cwd>/i)
		if (cwdMatch) {
			const extractedCwd = cwdMatch[1].trim()
			if (extractedCwd && !params.cwd) {
				params.cwd = extractedCwd
				repairs.push({
					type: 'param_extract',
					description: `Extracted <cwd> from inside <command>`,
					before: cmd,
					after: extractedCwd,
				})
			}
			cmd = cmd.replace(/<cwd>[\s\S]*?<\/cwd>/gi, '')
		}

		// Check if the agent mistakenly put <command> inside the command tag itself (nested tags)
		const cmdMatch = cmd.match(/<command>\s*([\s\S]*?)\s*<\/command>/i)
		if (cmdMatch) {
			const extractedCmd = cmdMatch[1].trim()
			repairs.push({
				type: 'param_extract',
				description: `Removed nested <command> tags`,
				before: cmd,
				after: extractedCmd,
			})
			cmd = extractedCmd
		}

		params.command = cmd.trim()
	}


	// ======================== Step 5: CWD Sanitization ========================

	private _sanitizeCwd(
		params: RawToolParamsObj,
		repairs: RepairEntry[],
	): void {
		if (typeof params.cwd === 'string') {
			const original = params.cwd
			let sanitized = stripRogueTags(params.cwd)
			sanitized = sanitized.replace(/^["`']+|["`']+$/g, '').trim()

			// Resolve relative cwd
			if (sanitized && this._workspaceRoot && !(/^[A-Za-z]:[\\/]/.test(sanitized) || sanitized.startsWith('/'))) {
				const sep = os === 'windows' ? '\\' : '/'
				sanitized = `${this._workspaceRoot}${sep}${sanitized.replace(/^\.[\\/]/, '')}`
			}

			// Default to workspace root if empty
			if (!sanitized && this._workspaceRoot) {
				sanitized = this._workspaceRoot
			}

			if (sanitized !== original) {
				repairs.push({
					type: 'cwd_strip',
					description: `Sanitized cwd`,
					before: original,
					after: sanitized,
				})
				params.cwd = sanitized
			}
		} else if (!params.cwd && this._workspaceRoot) {
			// Default cwd if not provided
			params.cwd = this._workspaceRoot
		}
	}


	// ======================== Step 6a: Terminal → XML Reroute Check ========================

	private _checkTerminalReroute(
		params: RawToolParamsObj,
		repairs: RepairEntry[],
	): { toolName: string, params: RawToolParamsObj } | null {
		const command = (params.command as string || '').trim()
		if (!command) return null

		const cwd = (params.cwd as string) || this._workspaceRoot

		for (const reroute of TERMINAL_TO_XML_REROUTES) {
			const match = command.match(reroute.pattern)
			if (match) {
				const newParams = reroute.extractParams(match, cwd)
				repairs.push({
					type: 'tool_reroute',
					description: `Rerouted terminal command to XML tool '${reroute.xmlTool}'`,
					before: `run_command: ${command}`,
					after: `${reroute.xmlTool}: ${JSON.stringify(newParams)}`,
				})
				return { toolName: reroute.xmlTool, params: newParams }
			}
		}

		return null
	}


	// ======================== Step 6b: Shell Command Translation ========================

	private _translateShellCommand(
		params: RawToolParamsObj,
		repairs: RepairEntry[],
	): void {
		if (typeof params.command !== 'string') return
		const command = params.command.trim()

		// Try each translation pattern
		for (const rule of SHELL_TRANSLATIONS) {
			const match = command.match(rule.pattern)
			if (match) {
				const translated = rule.translate(match)
				repairs.push({
					type: 'command_translate',
					description: `Translated bash → PowerShell${rule.warning ? ` (${rule.warning})` : ''}`,
					before: command,
					after: translated,
				})
				params.command = translated
				return
			}
		}
	}


	// ======================== Step 7: Command Validation ========================

	private _validateRunCommand(
		params: RawToolParamsObj,
		repairs: RepairEntry[],
	): { blocked: boolean, reason?: string } {
		if (typeof params.command !== 'string' || !params.command.trim()) {
			return { 
				blocked: true, 
				reason: `The 'command' parameter is missing. You MUST wrap the terminal command you want to execute inside a <command> tag. Example: <run_command><cwd>your/path</cwd><command>npm install</command></run_command>` 
			}
		}

		const cmd = params.command.trim()
		if (/^cd\s+/i.test(cmd) && !cmd.includes('&&') && !cmd.includes(';')) {
			return { 
				blocked: true, 
				reason: `Standalone 'cd' commands have no effect. Use the 'cwd' parameter (e.g., <cwd>path/to/dir</cwd>) to specify the working directory for your command instead.` 
			}
		}

		return { blocked: false }
	}


	// ======================== Step 8: Search/Replace Block Validation ========================

	private _validateSearchReplaceBlocks(
		params: RawToolParamsObj,
		repairs: RepairEntry[],
	): { blocked: boolean, reason?: string } {
		if (typeof params.search_replace_blocks !== 'string' || !params.search_replace_blocks.trim()) {
			return { blocked: true, reason: `The search_replace_blocks parameter is missing or empty. You must provide EXACT SEARCH/REPLACE blocks using the proper format.` }
		}
		
		const blocks = params.search_replace_blocks

		// Check if it contains at least one valid ORIGINAL/DIVIDER/FINAL triple
		const hasOriginal = blocks.includes(ORIGINAL)
		const hasDivider = blocks.includes(DIVIDER)
		const hasFinal = blocks.includes(FINAL)

		if (!hasOriginal || !hasDivider || !hasFinal) {
			return { blocked: true, reason: `Invalid SEARCH/REPLACE block format. You must strictly use the ${ORIGINAL}, ${DIVIDER}, and ${FINAL} markers.` }
		}
		
		return { blocked: false }
	}
}


registerSingleton(IAgentAssistService, AgentAssistService, InstantiationType.Eager)
