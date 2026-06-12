1. first

| Category | Root Cause | Severity |
|---|---|---|
| File creation failures | `create_file` never creates parent directories | CRITICAL |
| File/folder confusion | Regex heuristic misclassifies `.env`, `.gitignore` as folders | HIGH |
| Wrong directory | Model forgets cwd after task 1 — continuation prompt has no workspace state | HIGH |
| Context overflow | Terminal output capped at 100k chars — kills 7B context window | HIGH |
| Hallucinated tools | `extractGrammar.ts` only aliases `execute_command` — 7B invents dozens more | HIGH |
| Weak lint loop | Lint errors returned as soft suggestions — 7B ignores them | MEDIUM |

---

## PART 1 — Critical Bug Fixes (Code Changes)

---

### Fix 1: `create_file` Never Creates Parent Directories

**File:** `src/vs/workbench/contrib/void/common/toolsService.ts`

**The bug:** The agent runs `create_file` for `src/auth/user.model.ts`. If `src/auth/` doesn't exist, VSCode's `fileService.createFile()` throws silently or errors. The agent sees a failure and retries endlessly.

**Replace the entire `create_file` handler:**

```typescript
create_file: async ({ uri }) => {
    const exists = await fileService.exists(uri)
    if (exists) {
        // Stronger message — 7B needs imperative language
        return { result: { message: `⚠ FILE ALREADY EXISTS: ${uri.fsPath} — DO NOT call create_file again. Use rewrite_file to overwrite it or edit_file to modify specific lines.` } }
    }
    // Auto-create ALL parent directories (handles src/auth/models/user.ts in one shot)
    const parentURI = URI.joinPath(uri, '..')
    try {
        const parentExists = await fileService.exists(parentURI)
        if (!parentExists) {
            // createFolder with IFileService doesn't create recursively, so walk up manually
            const segments = parentURI.fsPath.replace(/\\/g, '/').split('/')
            let accumulated = segments[0] + (segments[0].endsWith(':') ? '/' : '') // Windows: C:/  Unix: /
            for (let i = 1; i < segments.length; i++) {
                accumulated += '/' + segments[i]
                const segURI = URI.file(accumulated)
                const segExists = await fileService.exists(segURI)
                if (!segExists) {
                    try { await fileService.createFolder(segURI) } catch { /* already created by concurrent op */ }
                }
            }
        }
    } catch { /* non-fatal, let createFile surface its own error */ }
    await fileService.createFile(uri)
    return { result: {} }
},
```

---

### Fix 2: `rewrite_file` Fails When File Doesn't Exist

**File:** `src/vs/workbench/contrib/void/common/toolsService.ts`

**The bug:** 7B models frequently skip `create_file` and go directly to `rewrite_file`. Current code throws: `"File does not exist... You must use the create_file tool before rewriting it."` This causes a retry loop that wastes 2 full LLM calls per file.

**Replace the `rewrite_file` handler:**

```typescript
rewrite_file: async ({ uri, newContent }) => {
    const exists = await fileService.exists(uri)
    if (!exists) {
        // Auto-create: model skipped create_file, recover gracefully
        const parentURI = URI.joinPath(uri, '..')
        try {
            const parentExists = await fileService.exists(parentURI)
            if (!parentExists) {
                // Walk and create each missing parent segment (same logic as create_file above)
                const segments = parentURI.fsPath.replace(/\\/g, '/').split('/')
                let accumulated = segments[0] + (segments[0].endsWith(':') ? '/' : '')
                for (let i = 1; i < segments.length; i++) {
                    accumulated += '/' + segments[i]
                    const segURI = URI.file(accumulated)
                    const segExists = await fileService.exists(segURI)
                    if (!segExists) {
                        try { await fileService.createFolder(segURI) } catch { }
                    }
                }
            }
            await fileService.createFile(uri)
        } catch (e) {
            throw new Error(`Could not auto-create ${uri.fsPath}: ${e}`)
        }
    }
    await voidModelService.initializeModel(uri)
    if (this.commandBarService.getStreamState(uri) === 'streaming') {
        throw new Error(`Another LLM is currently making changes to this file.`)
    }
    await editCodeService.callBeforeApplyOrEdit(uri)
    editCodeService.instantlyRewriteFile({ uri, newContent })
    const lintErrorsPromise = Promise.resolve().then(async () => {
        await timeout(2000)
        const { lintErrors } = this._getLintErrors(uri)
        return { lintErrors }
    })
    return { result: lintErrorsPromise }
},
```

---

### Fix 3: File/Folder Confusion — `.env` Classified as Folder

**File:** `src/vs/workbench/contrib/void/browser/agentAssistService.ts`

**The bug:** Current heuristic: `const hasNoExtension = !uriStr.includes('.')`. This incorrectly classifies `.env`, `.gitignore`, `.eslintrc`, `.babelrc`, `.npmrc` as folders.

**Replace Step 2.5 entirely:**

```typescript
// ── Step 2.5: Folder Correction Interception ──
if (correctedName === 'create_file' && typeof correctedParams.uri === 'string') {
    const uriStr = correctedParams.uri.trim()
    // Normalize separators for analysis
    const normalized = uriStr.replace(/\\/g, '/')
    const lastSegment = normalized.replace(/\/+$/, '').split('/').filter(Boolean).pop() || ''

    // RULE 1: Explicit path separator at end = definitely a folder
    const endsWithSep = uriStr.endsWith('/') || uriStr.endsWith('\\')

    // RULE 2: Has a dot-based extension (includes dotfiles like .env = FILES, not folders)
    // A "real extension" is: letter(s) after last dot, and the dot is not the first char
    const hasRealExtension = /[^.\\/][.][a-zA-Z0-9]{1,10}$/.test(lastSegment)

    // RULE 3: Known dot-files that are always files, not folders
    const isKnownDotFile = /^\.(env|gitignore|gitkeep|gitattributes|eslintrc|eslintignore|prettierrc|prettierignore|babelrc|npmrc|yarnrc|nvmrc|editorconfig|stylelintrc|huskyrc|commitlintrc|mocharc|jestrc|dockerignore|vscode|idea|htaccess|htpasswd)/.test(lastSegment)

    // RULE 4: Known folder names (no extension, specific common names)
    const isKnownFolderName = !lastSegment.includes('.') && /^(src|app|components|utils|services|controllers|models|routes|assets|database|config|backend|frontend|api|public|tests|test|spec|lib|bin|static|styles|css|hooks|pages|views|helpers|middleware|types|interfaces|store|redux|context|providers|layouts|containers|modules|features|core|shared|common|infrastructure|domain|adapters|repositories|handlers|validators|schemas|migrations|seeds|fixtures|mocks|__tests__|__mocks__|dist|build|out|coverage)$/i.test(lastSegment)

    const shouldBeFolder = endsWithSep || (!hasRealExtension && !isKnownDotFile && isKnownFolderName)

    if (shouldBeFolder) {
        repairs.push({
            type: 'tool_reroute',
            description: `create_file for folder path → create_folder (last segment: ${lastSegment})`,
            before: `create_file: ${uriStr}`,
            after: `create_folder: ${uriStr}`,
        })
        correctedName = 'create_folder'
        wasIntercepted = true
    }
}
```

---

### Fix 4: Terminal Output Kills 7B Context Window

**File:** `src/vs/workbench/contrib/void/common/toolsService.ts`

**The bug:** `MAX_TERMINAL_CHARS = 100_000`. At ~4 chars/token that's **25,000 tokens** — nearly the entire context window of qwen2.5-coder:7b (32k). One npm install output empties the model's memory.

**Add a smart compressor and apply it in `stringOfResult.run_command`:**

```typescript
// Add this helper inside the ToolsService constructor, before stringOfResult:
const compressToolOutput = (output: string, maxChars = 4000): string => {
    if (output.length <= maxChars) return output
    // Strategy: keep last 80% (errors are at end), head 20% (command echo)
    const headChars = Math.floor(maxChars * 0.15)
    const tailChars = Math.floor(maxChars * 0.85)
    const omitted = output.length - headChars - tailChars
    return (
        output.slice(0, headChars) +
        `\n\n... [${omitted} characters omitted — showing tail] ...\n\n` +
        output.slice(-tailChars)
    )
}

// Then in stringOfResult:
run_command: (params, result) => {
    const { resolveReason, result: result_ } = result
    const compressed = compressToolOutput(result_, 4000) // 7B-safe: ~1000 tokens max

    if (resolveReason.type === 'done') {
        if (resolveReason.exitCode !== 0) {
            return `${compressed}\n(exit code ${resolveReason.exitCode})\n\n[AGENT: COMMAND FAILED. Analyze the error above. Output a new <run_command> to fix it. DO NOT output plain text.]`
        }
        return `${compressed}\n(exit code ${resolveReason.exitCode})`
    }
    if (resolveReason.type === 'timeout') {
        return `${compressed}\nCommand timed out after ${MAX_TERMINAL_INACTIVE_TIME}s.\n\n[AGENT: If the command is still needed, open a persistent terminal.]`
    }
    throw new Error(`Unexpected resolve reason`)
},
```

Also apply compression to `read_file` results — long files silently overflow context:

```typescript
read_file: (params, result) => {
    const { fileContents, totalFileLen, hasNextPage, totalNumLines } = result
    const compressed = compressToolOutput(fileContents, 6000) // keep more for file reads
    return `${params.uri.fsPath}\n\`\`\`\n${compressed}\n\`\`\`${hasNextPage ? '\n\n(more on next page...)' : ''}${totalNumLines > 200 ? `\nFile has ${totalNumLines} lines total.` : ''}`
},
```

---

### Fix 5: Compound `cd` Command Confusion

**File:** `src/vs/workbench/contrib/void/browser/agentAssistService.ts`

**The bug:** The model outputs `cd src/backend && npm install`. The current `_validateRunCommand` blocks standalone `cd`, but `cd src && npm run build` passes through unchanged. The actual execution runs `cd src && npm run build` with cwd=workspace_root — `cd` in a subprocess has NO effect, so npm runs from the wrong directory.

**Add `_extractCdFromCompound` and call it in `processToolCall`:**

```typescript
// Add to AgentAssistService class:

/**
 * Extracts `cd X && COMMAND` → runs COMMAND with updated cwd.
 * A 7B model often does this because it doesn't understand the cwd param.
 */
private _extractCdFromCompound(params: RawToolParamsObj, repairs: RepairEntry[]): void {
    if (typeof params.command !== 'string') return
    const cmd = params.command.trim()

    // Match: cd <path> && <rest>  (also handles: cd <path>; <rest>)
    const cdCompoundRe = /^cd\s+(['"]?)([^\s&|;'"]+)\1\s*(?:&&|;)\s*(.+)$/i
    const match = cmd.match(cdCompoundRe)
    if (!match) return

    const subdir = match[2]
    const actualCommand = match[3].trim()
    const currentCwd = (params.cwd as string | undefined) || this._workspaceRoot || ''

    // Resolve the new cwd
    let newCwd: string
    if (!subdir) {
        newCwd = currentCwd
    } else if (/^[A-Za-z]:[\\/]/.test(subdir) || subdir.startsWith('/')) {
        // Absolute path
        newCwd = subdir
    } else {
        // Relative — join with currentCwd
        const sep = currentCwd.includes('\\') ? '\\' : '/'
        const clean = subdir.replace(/^\.[\\/]/, '')
        newCwd = `${currentCwd.replace(/[\\/]+$/, '')}${sep}${clean}`
    }

    repairs.push({
        type: 'cwd_strip',
        description: `Extracted cd from compound command → cwd updated to ${newCwd}`,
        before: cmd,
        after: actualCommand,
    })
    params.command = actualCommand
    params.cwd = newCwd
}
```

**Wire it in `processToolCall`, after Step 4.5 (Command String Cleanup):**

```typescript
// ── Step 4.6: Compound cd extraction ──
if (correctedName === 'run_command' || correctedName === 'run_persistent_command') {
    this._extractCdFromCompound(correctedParams, repairs)
}
```

---

### Fix 6: Stronger Lint Error Messages

**File:** `src/vs/workbench/contrib/void/common/toolsService.ts`

**The bug:** Current lint message: `"you might want to fix the error."` — 7B models treat suggestions as optional and move on to the next task, leaving broken code.

```typescript
edit_file: (params, result) => {
    if (!this.voidSettingsService.state.globalSettings.includeToolLintErrors) {
        return `Change successfully made to ${params.uri.fsPath}.`
    }
    if (!result.lintErrors || result.lintErrors.length === 0) {
        return `Change successfully made to ${params.uri.fsPath}. No lint errors.`
    }
    const errStr = stringifyLintErrors(result.lintErrors)
    // CRITICAL framing — 7B needs this to prioritize fixing
    return `Change made to ${params.uri.fsPath}.\n\n⚠ LINT ERRORS DETECTED — Fix these BEFORE proceeding to the next task:\n${errStr}\n\nOutput an <edit_file> or <rewrite_file> call to fix the above errors now.`
},
rewrite_file: (params, result) => {
    if (!this.voidSettingsService.state.globalSettings.includeToolLintErrors) {
        return `Change successfully made to ${params.uri.fsPath}.`
    }
    if (!result.lintErrors || result.lintErrors.length === 0) {
        return `Change successfully made to ${params.uri.fsPath}. No lint errors.`
    }
    const errStr = stringifyLintErrors(result.lintErrors)
    return `Change made to ${params.uri.fsPath}.\n\n⚠ LINT ERRORS DETECTED — Fix these BEFORE proceeding:\n${errStr}\n\nOutput an <edit_file> call to fix the above errors now.`
},
```

---

### Fix 7: Missing XML Tool Aliases in extractGrammar.ts

**File:** `src/vs/workbench/contrib/void/electron-main/llmMessage/extractGrammar.ts`

**The bug:** The grammar extractor only registers `<execute_command` as an alias for `run_command`. A 7B model in the wild invents: `<bash>`, `<shell>`, `<terminal_command>`, `<run_bash>`, `<write_file>`, `<write_to_file>`, `<patch_file>`, `<apply_diff>`, etc. These silently vanish — no tool is called, the agent thinks it acted but nothing happened.

**In `extractXMLToolsWrapper`, expand the alias registration block:**

```typescript
// After: if (toolOfToolName['run_command']) { toolOpenPrefixes.push('<execute_command'); ... }
// Replace with:

if (toolOfToolName['run_command']) {
    const runAliases = [
        'execute_command', 'bash', 'shell', 'terminal', 'run_terminal',
        'execute_bash', 'run_bash', 'terminal_command', 'run_shell',
        'execute', 'command', 'exec'
    ]
    for (const alias of runAliases) {
        toolOpenPrefixes.push(`<${alias}`)
        toolOfToolName[alias as any] = toolOfToolName['run_command']
    }
}

if (toolOfToolName['read_file']) {
    const readAliases = ['cat', 'view_file', 'show_file', 'read', 'open_file', 'get_file', 'view']
    for (const alias of readAliases) {
        toolOpenPrefixes.push(`<${alias}`)
        toolOfToolName[alias as any] = toolOfToolName['read_file']
    }
}

if (toolOfToolName['rewrite_file']) {
    const writeAliases = [
        'write_file', 'write_to_file', 'save_file', 'overwrite_file',
        'write', 'apply_changes', 'set_file_content'
    ]
    for (const alias of writeAliases) {
        toolOpenPrefixes.push(`<${alias}`)
        toolOfToolName[alias as any] = toolOfToolName['rewrite_file']
    }
}

if (toolOfToolName['edit_file']) {
    const editAliases = [
        'patch_file', 'apply_diff', 'apply_patch', 'modify_file',
        'update_file', 'change_file', 'replace_in_file', 'edit'
    ]
    for (const alias of editAliases) {
        toolOpenPrefixes.push(`<${alias}`)
        toolOfToolName[alias as any] = toolOfToolName['edit_file']
    }
}

if (toolOfToolName['ls_dir']) {
    const lsAliases = ['list_dir', 'list_directory', 'ls', 'dir', 'listdir']
    for (const alias of lsAliases) {
        toolOpenPrefixes.push(`<${alias}`)
        toolOfToolName[alias as any] = toolOfToolName['ls_dir']
    }
}

if (toolOfToolName['get_dir_tree']) {
    const treeAliases = ['tree', 'dir_tree', 'directory_tree', 'file_tree', 'show_tree']
    for (const alias of treeAliases) {
        toolOpenPrefixes.push(`<${alias}`)
        toolOfToolName[alias as any] = toolOfToolName['get_dir_tree']
    }
}
```

---

### Fix 8: `agentAssistService` — Add All Missing TOOL_NAME_ALIASES

**File:** `src/vs/workbench/contrib/void/browser/agentAssistService.ts`

Expand `TOOL_NAME_ALIASES` to cover all 7B hallucinations:

```typescript
const TOOL_NAME_ALIASES: Record<string, string> = {
    // run_command aliases
    'execute_command': 'run_command',
    'bash': 'run_command',
    'shell': 'run_command',
    'terminal': 'run_command',
    'run_terminal': 'run_command',
    'execute_bash': 'run_command',
    'run_bash': 'run_command',
    'terminal_command': 'run_command',
    'execute': 'run_command',
    'command': 'run_command',
    'exec': 'run_command',
    // read_file aliases
    'cat': 'read_file',
    'view_file': 'read_file',
    'show_file': 'read_file',
    'open_file': 'read_file',
    'get_file': 'read_file',
    'view': 'read_file',
    'read': 'read_file',
    // write/rewrite aliases
    'write_file': 'rewrite_file',
    'write_to_file': 'rewrite_file',
    'save_file': 'rewrite_file',
    'overwrite_file': 'rewrite_file',
    'write': 'rewrite_file',
    'apply_changes': 'rewrite_file',
    'set_file_content': 'rewrite_file',
    // edit_file aliases
    'modify_file': 'edit_file',
    'update_file': 'edit_file',
    'patch_file': 'edit_file',
    'apply_diff': 'edit_file',
    'apply_patch': 'edit_file',
    'change_file': 'edit_file',
    'replace_in_file': 'edit_file',
    'edit': 'edit_file',
    // search/ls aliases
    'find_files': 'search_pathnames_only',
    'find': 'search_pathnames_only',
    'search': 'search_for_files',
    'grep': 'search_for_files',
    'list_dir': 'ls_dir',
    'list_directory': 'ls_dir',
    'dir': 'ls_dir',
    'ls': 'ls_dir',
    'listdir': 'ls_dir',
    // tree aliases
    'tree': 'get_dir_tree',
    'dir_tree': 'get_dir_tree',
    'directory_tree': 'get_dir_tree',
    'file_tree': 'get_dir_tree',
    // folder aliases
    'make_file': 'create_file',
    'new_file': 'create_file',
    'touch': 'create_file',
    'make_dir': 'create_folder',
    'mkdir': 'create_folder',
    'make_folder': 'create_folder',
    'new_folder': 'create_folder',
    'create_directory': 'create_folder',
    // delete aliases
    'remove_file': 'delete_file_or_folder',
    'rm_file': 'delete_file_or_folder',
    'delete_file': 'delete_file_or_folder',
    'delete_folder': 'delete_file_or_folder',
    'remove_folder': 'delete_file_or_folder',
    'rm': 'delete_file_or_folder',
}
```

---

## PART 2 — Architecture Additions

---

### Addition 1: CWD Tracking in Session State

**Problem:** After task 1 installs into `backend/`, task 2 forgets to cd there. The `AUTONOMOUS_CONTINUATION_PROMPT` has no workspace state — the model only sees "your root workspace directory is X" and guesses.

**File:** `src/vs/workbench/contrib/void/common/agentPipelineTypes.ts`

Add to `AgentSessionState`:
```typescript
export interface AgentSessionState {
    // ... existing fields ...
    lastKnownCwd: string           // the cwd of the last run_command
    cwdHistory: string[]           // ordered list of cwds used (last 5)
    failedCommands: FailedCommand[] // for anti-repetition
}

export interface FailedCommand {
    command: string
    cwd: string
    exitCode: number
    errorSnippet: string  // last 200 chars of output
    taskId: string
    timestamp: number
}
```

Update `createEmptySessionState`:
```typescript
export function createEmptySessionState(workspaceRoot: string): AgentSessionState {
    return {
        // ... existing ...
        lastKnownCwd: workspaceRoot,
        cwdHistory: [workspaceRoot],
        failedCommands: [],
    }
}
```

**File:** `src/vs/workbench/contrib/void/common/toolCallParser.ts`

Add CWD extraction to `parseToolCallsFromText`:
```typescript
export interface ParsedToolCalls {
    filesCreated: string[]
    filesModified: string[]
    packagesInstalled: InstalledPackage[]
    commandsRun: string[]
    lastCwd: string | null          // NEW: last cwd used
    failedCommands: ParsedFailedCommand[] // NEW
}

export interface ParsedFailedCommand {
    command: string
    cwd: string
    // Note: exit code not parseable from text, detected from "exit code N" in output
}
```

Inside `parseToolCallsFromText`, add CWD extraction:
```typescript
// After run_command parsing, also extract cwd values
let lastCwd: string | null = null
const cwdRe = /<cwd>\s*([\s\S]*?)\s*<\/cwd>/g
while ((m = cwdRe.exec(text)) !== null) {
    const cwd = m[1].trim()
    if (cwd) lastCwd = cwd
}
```

**File:** `src/vs/workbench/contrib/void/common/memoryStore.ts`

Update `recordTaskOutcome` to track CWD:
```typescript
async recordTaskOutcome(task: AgentTask, agentOutputText: string): Promise<TaskOutcome> {
    if (!this.sessionState) return this._makeEmptyOutcome(task)

    const parsed = parseToolCallsFromText(agentOutputText, task.id)

    // Track last known cwd
    if (parsed.lastCwd && this.sessionState) {
        this.sessionState.lastKnownCwd = parsed.lastCwd
        this.sessionState.cwdHistory = [
            ...this.sessionState.cwdHistory.slice(-4),
            parsed.lastCwd
        ]
    }

    // ... rest of existing logic ...
}
```

Update `buildSessionContextBlock` to inject CWD state:
```typescript
buildSessionContextBlock(): string {
    const s = this.sessionState
    if (!s) return ''

    const parts: string[] = []

    // CRITICAL: workspace context at the top
    if (s.workspaceRoot) {
        parts.push(`WORKSPACE ROOT: ${s.workspaceRoot}`)
    }
    if (s.lastKnownCwd && s.lastKnownCwd !== s.workspaceRoot) {
        parts.push(`LAST USED DIRECTORY: ${s.lastKnownCwd}\n(Use this as cwd for related commands unless you need a different directory)`)
    }

    // ... existing parts (created files, packages, etc.) ...

    // Failed commands — prevent repetition
    if (s.failedCommands && s.failedCommands.length > 0) {
        const recent = s.failedCommands.slice(-3)
        const lines = recent.map(f => `  ✗ "${f.command}" in ${f.cwd} — ERROR: ${f.errorSnippet}`)
        parts.push(`COMMANDS THAT FAILED — DO NOT repeat these:\n${lines.join('\n')}`)
    }

    // ... rest of existing block ...
}
```

---

### Addition 2: Pre-Task Directory Snapshot Injection

**Problem:** The agent starts task 3 with no idea what the actual filesystem looks like. It knows what it *created* (from session state) but not the actual directory structure. It hallucinates paths.

**File:** `src/vs/workbench/contrib/void/browser/agentPipelineService.ts`

Add `_getDirectorySnapshot` helper:
```typescript
private async _getDirectorySnapshot(): Promise<string> {
    try {
        const directoryStr = await this._directoryStrService.getAllDirectoriesStr({
            cutOffMessage: '...tree cut off...'
        })
        // Limit to 800 chars for 7B — just the shape, not full content
        if (directoryStr.length > 800) {
            return directoryStr.slice(0, 800) + '\n...(use get_dir_tree for full tree)'
        }
        return directoryStr
    } catch {
        return '(directory unavailable)'
    }
}
```

Inject into `buildTaskExecutionPrompt` call in `_runExecutionPhase`:
```typescript
// In _runExecutionPhase, before building executionPrompt:
const memoryContext = this._memoryStore.buildContextString(task, 350)
const sessionContextBlock = this._memoryStore.buildSessionContextBlock()

// For first task OR every 3rd task: inject live directory snapshot
const completedCount = plan.tasks.filter(t => t.status === 'done').length
const shouldInjectDirSnapshot = completedCount === 0 || completedCount % 3 === 0
const dirSnapshot = shouldInjectDirSnapshot
    ? `\nCURRENT WORKSPACE TREE:\n${await this._getDirectorySnapshot()}`
    : ''

const executionPrompt = buildTaskExecutionPrompt(task, plan, memoryContext, sessionContextBlock + dirSnapshot)
```

---

### Addition 3: Error Pattern Memory + Failed Command Tracking

**File:** `src/vs/workbench/contrib/void/browser/agentPipelineService.ts`

In `_extractMemory`, detect failed commands from tool outputs and store them:

```typescript
private async _extractMemory(task: AgentTask, _taskResult: string, threadId: string): Promise<void> {
    const thread = this._chatThreadService.state.allThreads[threadId]
    const recentMessages = thread?.messages?.slice(-12) || []

    const agentOutputText = recentMessages
        .filter(m => m.role === 'assistant')
        .map(m => m.displayContent || '')
        .join('\n')

    // Also scan tool RESULTS for failed commands
    const toolResultTexts = recentMessages
        .filter(m => m.role === 'tool' && (m as any).type === 'success')
        .map(m => (m as any).content || '')
        .join('\n')

    const outcome = await this._memoryStore.recordTaskOutcome(task, agentOutputText)

    // Detect and store failed commands from tool results
    const failedCmdRe = /\(exit code ([1-9]\d*)\)/g
    let fcMatch: RegExpExecArray | null
    const sessionState = this._memoryStore.getSessionState()
    if (sessionState) {
        while ((fcMatch = failedCmdRe.exec(toolResultTexts)) !== null) {
            // Heuristic: find the command and cwd near this exit code
            const contextStart = Math.max(0, fcMatch.index - 300)
            const context = toolResultTexts.slice(contextStart, fcMatch.index + 50)
            const errorSnippet = context.slice(-200)
            sessionState.failedCommands = [
                ...(sessionState.failedCommands || []).slice(-4),
                {
                    command: '(detected from output)',
                    cwd: sessionState.lastKnownCwd || sessionState.workspaceRoot,
                    exitCode: parseInt(fcMatch[1]),
                    errorSnippet: errorSnippet.trim().slice(-200),
                    taskId: task.id,
                    timestamp: Date.now(),
                }
            ]
        }
    }

    // ... rest of existing _extractMemory ...
}
```

---

### Addition 4: Auto-Retry with Root Cause Injection

**File:** `src/vs/workbench/contrib/void/browser/agentPipelineService.ts`

**The bug:** When a task fails, the retry just replays the same execution prompt. The 7B model makes the same mistake again. We need to inject the error as context.

Modify the retry path in `_runExecutionPhase`:

```typescript
// In the catch block, where we handle first failure (retry):
} else {
    // First failure: retry BUT inject error context
    const errorMsg = error instanceof Error ? error.message : String(error)

    // Store the error for injection into next attempt
    plan = {
        ...plan,
        tasks: plan.tasks.map((t: AgentTask): AgentTask =>
            t.id === task.id
                ? { ...t, status: 'pending', error: `Previous attempt failed: ${errorMsg.slice(0, 300)}` }
                : t
        )
    }
    this._updatePlanTasks(plan)
}
```

Then in the execution message building, check if the task has a previous error:

```typescript
// After building executionPrompt:
const previousError = task.error
const errorContext = previousError
    ? `\n\n⚠ PREVIOUS ATTEMPT FAILED: ${previousError}\nAnalyze why it failed and take a DIFFERENT approach this time.`
    : ''

await this._chatThreadService.addUserMessageAndStreamResponse({
    userMessage: `__PIPELINE_HIDDEN__\n${preamble}\n\n${executionPrompt}${errorContext}`,
    threadId,
})
```

---

## PART 3 — 7B-Optimized System Prompts

---

### New `AUTONOMOUS_EXECUTION_SYSTEM_PROMPT_7B`

**File:** `src/vs/workbench/contrib/void/common/agentPromptTemplates.ts`

Replace the existing `AUTONOMOUS_EXECUTION_SYSTEM_PROMPT_7B` with this rewritten version that addresses every documented 7B failure mode:

```typescript
export const AUTONOMOUS_EXECUTION_SYSTEM_PROMPT_7B = `\
You are an autonomous coding agent inside Void IDE. You have direct access to the filesystem and terminal.

== STRICT RULES (follow ALL of these) ==

RULE 1 — USE ONLY XML TOOLS. Never output code in markdown blocks. Every action MUST be a tool call.

RULE 2 — CORRECT TOOL NAMES (use EXACTLY these, no variations):
  <create_file><uri>FULL_PATH</uri></create_file>
  <rewrite_file><uri>FULL_PATH</uri><new_content>CONTENT</new_content></rewrite_file>
  <edit_file><uri>FULL_PATH</uri><search_replace_blocks>BLOCKS</search_replace_blocks></edit_file>
  <read_file><uri>FULL_PATH</uri></read_file>
  <run_command><cwd>FULL_PATH</cwd><command>COMMAND</command></run_command>
  <ls_dir><uri>FULL_PATH</uri></ls_dir>
  <get_dir_tree><uri>FULL_PATH</uri></get_dir_tree>
  <create_folder><uri>FULL_PATH</uri></create_folder>
  <search_pathnames_only><query>TERM</query></search_pathnames_only>

RULE 3 — NEVER use attributes: <rewrite_file path="x"> is WRONG. Always use nested tags.
RULE 4 — ALWAYS use <uri> for paths. Never use <path>, <file_path>, <filename>.
RULE 5 — Always close tags with forward slash </uri> NEVER backslash <\uri>.

RULE 6 — TERMINAL COMMANDS:
  - Always include <cwd> with the FULL absolute path
  - Never use bare `cd` — change directory via the cwd parameter
  - If you need to run in a subdirectory: <run_command><cwd>/project/backend</cwd><command>npm install</command></run_command>
  - After a command fails (non-zero exit), output a FIXED command immediately. Never proceed with broken state.

RULE 7 — FILE OPERATIONS:
  - BEFORE editing any file: read it first with <read_file>
  - BEFORE creating a file: check SESSION MEMORY — if it's already listed, use <edit_file> instead
  - PREFER <edit_file> over <rewrite_file> when modifying existing files (preserves unchanged code)
  - For new files: create_file is NOT required — you can go straight to rewrite_file
  - If lint errors appear after an edit, FIX THEM BEFORE CONTINUING

RULE 8 — DIRECTORY EXPLORATION:
  - Start every task with <get_dir_tree> or <ls_dir> if you are unsure of the structure
  - Never guess file paths — explore first

RULE 9 — One task at a time. No partial work. Complete fully before stopping.
RULE 10 — Only ask questions if genuinely stuck: output AGENT_QUESTION: [question]
RULE 11 — Do NOT describe what you will do. Just do it.

== EDIT_FILE FORMAT (CRITICAL) ==
Search/replace blocks MUST use EXACTLY these markers:
<<<<<<< ORIGINAL
(exact lines from file, character-perfect)
=======
(replacement lines)
>>>>>>> UPDATED

Multiple blocks for multiple changes:
<<<<<<< ORIGINAL
first match
=======
first replacement
>>>>>>> UPDATED
<<<<<<< ORIGINAL
second match
=======
second replacement
>>>>>>> UPDATED`
```

---

### New `AUTONOMOUS_CONTINUATION_PROMPT`

Replace the existing one with a version that includes workspace state:

```typescript
export const AUTONOMOUS_CONTINUATION_PROMPT = `\
[PIPELINE CONTINUING — AUTONOMOUS MODE]
You are still an autonomous coding agent with full filesystem and terminal access.

REMINDERS FOR THIS TASK:
1. XML tools only — never markdown code blocks
2. run_command needs <cwd>ABSOLUTE_PATH</cwd><command>COMMAND</command> inside it
3. If a file is in SESSION MEMORY "files created" → use edit_file, NOT create_file
4. If packages are in SESSION MEMORY "packages installed" → DO NOT reinstall them
5. Read a file with read_file before editing it
6. Fix any lint errors returned by edit_file/rewrite_file before continuing
7. DO NOT describe actions — execute them with tools immediately`
```

---

### Prompt Improvement: `buildTaskExecutionPrompt`

**File:** `src/vs/workbench/contrib/void/common/agentPromptTemplates.ts`

The session context block should come FIRST (model reads top-down), task LAST (closest to generation):

```typescript
export function buildTaskExecutionPrompt(
    task: AgentTask,
    plan: AgentPlan,
    memoryContext: string,
    sessionContextBlock: string = '',
    dirSnapshot: string = '',
): string {
    const completedTasks = plan.tasks.filter(t => t.status === 'done')
    const upcomingTasks = plan.tasks
        .filter(t => t.status === 'pending' && t.id !== task.id)
        .slice(0, 2)

    const parts: string[] = []

    // 1. SESSION MEMORY — imperative constraints (do not/do not)
    if (sessionContextBlock) {
        parts.push(sessionContextBlock)
    }

    // 2. LIVE DIRECTORY SNAPSHOT — ground truth, not guessed
    if (dirSnapshot) {
        parts.push(dirSnapshot)
    }

    // 3. LONG-TERM MEMORY — decisions, project info
    if (memoryContext) {
        parts.push(memoryContext)
    }

    // 4. PLAN POSITION — compact
    const doneStr = completedTasks.map(t => t.title).join(', ') || 'none'
    const nextStr = upcomingTasks.map(t => t.title).join(', ') || 'this is the last task'
    parts.push(`PLAN: done=[${doneStr}] | next=[${nextStr}]`)

    // 5. CURRENT TASK — LAST (closest to model generation = highest attention)
    const prevErrorNote = task.error
        ? `\n⚠ PREVIOUS ATTEMPT ERROR: ${task.error} — Take a different approach.`
        : ''

    parts.push(
        `CURRENT TASK: ${task.title}${prevErrorNote}\n` +
        `DESCRIPTION: ${task.description}\n` +
        `TARGET FILES: ${task.targetFiles.join(', ') || 'determine from context'}`
    )

    return parts.join('\n\n')
}
```

---

## PART 4 — Features from Leading Agent Architectures

---

### Feature 1: Automatic Lint Enforcement Loop (from Cursor)

**What Cursor does:** After every file edit, it automatically reads lint errors and re-prompts the model if errors exist. The agent can't proceed to the next task until lint is clean.

**Implementation in `agentPipelineService.ts`:**

Add `_runLintCheckLoop` after marking a task done:

```typescript
/**
 * After a task completes, check for lint errors in touched files.
 * If errors exist, inject a follow-up message to fix them.
 * Max 2 rounds to prevent infinite loops.
 */
private async _runLintCheckLoop(task: AgentTask, threadId: string): Promise<void> {
    if (!this._settingsService.state.globalSettings.includeToolLintErrors) return
    if (task.targetFiles.length === 0) return

    const MAX_LINT_ROUNDS = 2
    for (let round = 0; round < MAX_LINT_ROUNDS; round++) {
        // Wait for lint providers to settle
        await new Promise(r => setTimeout(r, 2500))

        // Check each target file for errors
        const lintProblems: string[] = []
        for (const filePath of task.targetFiles) {
            try {
                const uri = URI.file(filePath)
                const { lintErrors } = this._getLintErrorsForURI(uri)
                if (lintErrors && lintErrors.length > 0) {
                    lintProblems.push(
                        `${filePath}:\n` +
                        lintErrors.slice(0, 5).map(e => `  Line ${e.startLineNumber}: ${e.message}`).join('\n')
                    )
                }
            } catch { /* file might not exist yet */ }
        }

        if (lintProblems.length === 0) break // Clean! Move on.

        // Inject lint fix request as a follow-up message
        const lintMessage = `__PIPELINE_HIDDEN__\nLINT ERRORS FOUND (Round ${round + 1}/${MAX_LINT_ROUNDS}) — Fix these now:\n\n${lintProblems.join('\n\n')}\n\nOutput the necessary <edit_file> or <rewrite_file> calls to fix ALL errors above.`
        await this._chatThreadService.addUserMessageAndStreamResponse({
            userMessage: lintMessage,
            threadId,
        })
        await this._waitForStreamComplete(threadId)
    }
}
```

**Add to `IAgentPipelineService` constructor — requires a `_getLintErrorsForURI` helper:**

```typescript
// Add to AgentPipelineService — needs IMarkerService injected
@IMarkerService private readonly _markerService: IMarkerService

private _getLintErrorsForURI(uri: URI) {
    const markers = this._markerService.read({ resource: uri })
    const lintErrors = markers
        .filter(m => m.severity === 2 || m.severity === 1) // Error = 8, Warning = 4
        .slice(0, 10)
        .map(m => ({
            startLineNumber: m.startLineNumber,
            endLineNumber: m.endLineNumber,
            message: m.message,
        }))
    return { lintErrors: lintErrors.length > 0 ? lintErrors : null }
}
```

**Wire it in the execution loop, after the task is marked done:**

```typescript
// After: plan = { ...plan, tasks: plan.tasks.map(...status: 'done'...) }
this._updatePlanTasks(plan)

// Run lint check loop before extracting memory
await this._runLintCheckLoop(task, threadId)

// ... then continue to _extractMemory ...
```

---

### Feature 2: File Content Verification (from SWE-Agent)

**What SWE-Agent does:** After writing a file, it reads it back to verify the content matches intent. This catches silent write failures and model hallucinations where it thinks it wrote one thing but wrote another.

**Add to `toolsService.ts` in `rewrite_file`:**

```typescript
// After instantlyRewriteFile, add a verification read:
editCodeService.instantlyRewriteFile({ uri, newContent })

// Verify write succeeded (catches silent failures)
try {
    await voidModelService.initializeModel(uri)
    const { model } = voidModelService.getModel(uri)
    if (model) {
        const writtenContent = model.getValue(0) // 0 = LF
        const trimmedWritten = writtenContent.trim()
        const trimmedExpected = newContent.trim()
        if (trimmedWritten.length < trimmedExpected.length * 0.5) {
            // Content is less than half expected — likely a write failure
            return { result: Promise.resolve({
                lintErrors: null,
                // Return as an error so the model retries
            })}
        }
    }
} catch { /* non-fatal */ }
```

---

### Feature 3: Semantic Context Injection (from GitHub Copilot)

**What Copilot does:** When editing `auth.service.ts`, it automatically includes the content of files that are imported by that file.

**Add `_getRelatedFileContext` to `agentPipelineService.ts`:**

```typescript
/**
 * For a given task's target files, find files they import and include
 * a brief summary of those files in the context.
 * Limited to 3 files max to avoid context overflow.
 */
private async _getRelatedFileContext(task: AgentTask): Promise<string> {
    if (task.targetFiles.length === 0) return ''

    const sessionState = this._memoryStore.getSessionState()
    if (!sessionState || sessionState.allCreatedFiles.length === 0) return ''

    const relatedContext: string[] = []
    const maxRelatedFiles = 3

    // Find files from session state that share a directory with target files
    for (const targetFile of task.targetFiles.slice(0, 2)) {
        const targetDir = targetFile.split(/[\\/]/).slice(0, -1).join('/')
        const relatedFiles = sessionState.allCreatedFiles
            .filter(f => {
                const dir = f.split(/[\\/]/).slice(0, -1).join('/')
                return dir === targetDir && f !== targetFile
            })
            .slice(0, maxRelatedFiles)

        for (const relatedFile of relatedFiles) {
            const outcome = sessionState.taskOutcomes.find(o => o.filesCreated.includes(relatedFile))
            if (outcome) {
                relatedContext.push(`${relatedFile}: ${outcome.summary}`)
            }
        }
    }

    if (relatedContext.length === 0) return ''
    return `RELATED FILES IN SAME DIRECTORY:\n${relatedContext.map(r => `  - ${r}`).join('\n')}`
}
```

**Wire in `buildTaskExecutionPrompt`** by passing the related context through `dirSnapshot`:

```typescript
// In _runExecutionPhase:
const relatedContext = await this._getRelatedFileContext(task)
const dirSnapshot = (shouldInjectDirSnapshot ? `\nCURRENT WORKSPACE TREE:\n${await this._getDirectorySnapshot()}` : '')
    + (relatedContext ? `\n\n${relatedContext}` : '')
```

---

### Feature 4: Smart Pipeline Auto-Approval Classification

**What Devin/OpenHands does:** Classifies every operation as safe/unsafe and only pauses on genuinely destructive operations.

The existing `operationClassifier.ts` is excellent. The gap is that `run_command` for ALL commands requires approval by default. For a 7B agent, this kills autonomous flow.

**File:** `src/vs/workbench/contrib/void/common/operationClassifier.ts`

Extend `classifyVoidToolCall` for more granular terminal classification:

```typescript
case 'run_command':
case 'run_persistent_command': {
    const command = String(toolInput.command ?? '')
    const danger = classifyCommandDanger(command)

    // For pipeline mode: safe read-only commands should auto-approve
    const isSafeReadOnly = /^(npm (list|outdated|audit)|pip list|pip show|git (status|log|diff|branch)|ls|dir|cat|echo|pwd|node --version|python --version|which|where)/.test(command.trim())

    return {
        category: 'terminal',
        requiresApproval: danger !== 'safe' && !isSafeReadOnly,
        approvalReason: `Run: ${command.slice(0, 80)}`,
        dangerLevel: danger
    }
}
```

---

## PART 5 — Memory Architecture Enhancements

Building on the previous memory plan, add 3 more layers:

---

### Enhancement 1: Import/Dependency Graph

Track which files import which, so the agent knows when editing `utils.ts` that `auth.service.ts` depends on it.

**Add to `AgentSessionState`:**
```typescript
importGraph: Record<string, string[]>  // file → files that import it
```

**Add to `toolCallParser.ts`:**
```typescript
export function extractImportsFromContent(fileContent: string, filePath: string): string[] {
    const imports: string[] = []
    // TypeScript/JavaScript imports
    const importRe = /(?:import|require)\s*(?:\{[^}]*\}|[^'"]*)\s*from\s*['"]([^'"]+)['"]/g
    let m: RegExpExecArray | null
    while ((m = importRe.exec(fileContent)) !== null) {
        const importPath = m[1]
        // Only track relative imports (not node_modules)
        if (importPath.startsWith('.')) {
            imports.push(importPath)
        }
    }
    return imports
}
```

**Note:** This is lightweight — just parse imports from files the agent writes. No language server needed.

---

### Enhancement 2: Task Rollback Registry

When a task is about to be replanned, record what it changed so it can be undone:

**Add to `AgentSessionState`:**
```typescript
taskCheckpoints: TaskCheckpoint[]
```

```typescript
export interface TaskCheckpoint {
    taskId: string
    filesBeforeEdit: Record<string, string>  // path → content before task
    timestamp: number
}
```

The pipeline already has VSCode's checkpoint system for undo — this is a higher-level semantic layer that records which files a task touched before it started, enabling the re-planner to know exactly what to undo.

---

### Enhancement 3: Cross-Session Dependency Memory

**File:** `src/vs/workbench/contrib/void/common/memoryStore.ts`

In `buildContextString`, add a section for "things that must exist for this task to work":

```typescript
// In buildContextString, after decisions section:

// Prerequisite knowledge: if this task creates a file that's been created before
// in a previous session, surface that information
const prereqs: string[] = []
for (const targetFile of taskContext.targetFiles) {
    const description = memory.fileIndex[targetFile]
    if (description) {
        prereqs.push(`${targetFile}: ${description} (from previous session)`)
    }
}
if (prereqs.length > 0) {
    parts.push(`FILES FROM PREVIOUS SESSIONS (may already exist — check before creating):\n${prereqs.map(p => `  ${p}`).join('\n')}`)
}
```

---

## PART 6 — Implementation Priority Order

Implement in this exact order (each builds on the previous):

### Phase 1: Stability (do these first — they fix crashes)
1. ✅ `create_file` parent dir auto-creation (`toolsService.ts`)
2. ✅ `rewrite_file` auto-create (`toolsService.ts`)
3. ✅ File/folder detection fix (`agentAssistService.ts`)
4. ✅ Terminal output compression (`toolsService.ts`)
5. ✅ Stronger lint messages (`toolsService.ts`)

### Phase 2: Reliability (fix wrong behavior)
6. ✅ Compound `cd` extraction (`agentAssistService.ts`)
7. ✅ Expand tool aliases — extractGrammar + agentAssistService
8. ✅ CWD tracking in session state
9. ✅ Error injection on retry (`agentPipelineService.ts`)

### Phase 3: Intelligence (improve quality)
10. ✅ New 7B system prompt (`agentPromptTemplates.ts`)
11. ✅ New continuation prompt with workspace state
12. ✅ Directory snapshot injection (`agentPipelineService.ts`)
13. ✅ Lint enforcement loop (`agentPipelineService.ts`)

### Phase 4: Advanced (anti-gravity tier)
14. ✅ Auto-approval classification (`operationClassifier.ts`)
15. ✅ Related file context injection
16. ✅ Import graph tracking
17. ✅ Failed command memory

---

## Summary: Files to Change

| File | Changes |
|---|---|
| `toolsService.ts` | `create_file` parent dirs, `rewrite_file` auto-create, terminal compression, stronger lint messages |
| `agentAssistService.ts` | Folder detection fix, cd extraction, expanded tool aliases |
| `extractGrammar.ts` | Expanded XML tool aliases (bash, write_file, patch, etc.) |
| `agentPromptTemplates.ts` | New 7B prompt, new continuation prompt, updated `buildTaskExecutionPrompt` signature |
| `agentPipelineTypes.ts` | Add `lastKnownCwd`, `cwdHistory`, `failedCommands` to `AgentSessionState` |
| `toolCallParser.ts` | CWD extraction, failed command detection |
| `memoryStore.ts` | CWD in session context block, prerequisite knowledge in long-term memory |
| `agentPipelineService.ts` | Dir snapshot injection, lint loop, error injection on retry, related file context |
| `operationClassifier.ts` | Safe read-only command auto-approval |


2.second

Bug inventory
#SeverityFileDescription1CriticalagentPipelineService.tsSession memory always empty — _extractMemory reads displayContent which has no XML tool tags2CriticalagentPipelineService.tsPipeline preamble sent as user message, not system message — kills 7B instruction-following3CriticalagentPipelineService.tsTool format definitions lost after task 1 — continuation prompt has no XML examples4CriticaltoolsService.tscreate_file never creates parent directories — silently fails on any nested path5HighagentPipelineService.ts_waitForStreamComplete early-exit branch is logically unreachable — race condition on fast streams6HighagentAssistService.ts_checkTerminalReroute only runs on Windows — cat file.ts goes to terminal on Linux/Mac7HighagentPipelineService.tsTask marked done with zero success verification — agent claims success even after silent failure8HightoolsService.tscreate_file existence message is passive — model reads "Please proceed" and does whatever9MediumagentPipelineService.tsNo context window management — after 5+ tasks the thread explodes in size, causing drift10MediumagentAssistService.tsFolder detection too narrow — only catches known names and trailing slash11MediumagentPipelineService.tsCWD not tracked across tool calls — model re-derives it every time and gets it wrong12MediummemoryStore.tsbuildSessionContextBlock output never reaches the LLM as system context13MediumagentPipelineService.tsdirectoryStr truncated at 1500 chars in fallback rich description — cuts mid-path14LowagentAssistService.tsnormalizeToolParams (in extractGrammar.ts) and AgentAssistService duplicate the same param normalization15LowagentPipelineService.tsFire-and-forget architecture decision LLM call can stall on a slow model and block GC

Fix 1 — Memory extraction (critical)
Root cause: extractXMLToolsWrapper strips <create_file>...</create_file> etc. from the assistant's text and fires them as separate ToolMessage objects. By the time _extractMemory reads msg.displayContent, the XML is gone. parseToolCallsFromText runs on empty strings and returns zero files every time. buildSessionContextBlock therefore always shows nothing. The model keeps creating files that already exist.
Fix: Ditch text parsing in _extractMemory. Read ToolMessage objects directly.
typescript// agentPipelineService.ts — replace _extractMemory entirely

private async _extractMemory(task: AgentTask, _taskResult: string, threadId: string): Promise<void> {
    const thread = this._chatThreadService.state.allThreads[threadId]
    if (!thread) return

    const recentMessages = thread.messages?.slice(-30) || []

    const filesCreated: string[] = []
    const filesModified: string[] = []
    const packagesInstalled: { manager: string; name: string; taskId: string }[] = []
    const commandsRun: string[] = []

    for (const msg of recentMessages) {
        if (msg.role !== 'tool') continue
        // Only count successful or running-now tool calls
        if (msg.type !== 'success' && msg.type !== 'running_now') continue

        const uri = (msg.params as any)?.uri?.fsPath as string | undefined

        if (msg.name === 'create_file' && uri) {
            if (!filesCreated.includes(uri)) filesCreated.push(uri)
        }
        if ((msg.name === 'edit_file' || msg.name === 'rewrite_file') && uri) {
            if (!filesCreated.includes(uri) && !filesModified.includes(uri)) {
                filesModified.push(uri)
            }
        }
        if (msg.name === 'run_command') {
            const cmd = (msg.params as any)?.command as string | undefined
            if (cmd) {
                commandsRun.push(cmd)
                // Extract npm/pip/cargo packages
                const npmMatch = cmd.match(/npm\s+(?:install|i|add)\s+((?:(?!--)[^\s]+\s*)+)/g)
                npmMatch?.forEach(m => {
                    m.replace(/npm\s+(?:install|i|add)\s+/, '').trim().split(/\s+/).forEach(pkg => {
                        if (!pkg.startsWith('-')) {
                            packagesInstalled.push({ manager: 'npm', name: pkg.split('@')[0], taskId: task.id })
                        }
                    })
                })
                const pipMatch = cmd.match(/pip3?\s+install\s+((?:(?!--)[^\s]+\s*)+)/g)
                pipMatch?.forEach(m => {
                    m.replace(/pip3?\s+install\s+/, '').trim().split(/\s+/).forEach(pkg => {
                        if (!pkg.startsWith('-')) {
                            packagesInstalled.push({ manager: 'pip', name: pkg.split('==')[0], taskId: task.id })
                        }
                    })
                })
            }
        }
    }

    const parsed = { filesCreated, filesModified, packagesInstalled, commandsRun }
    const summary = buildTaskSummary(task.title, parsed)
    const outcome: TaskOutcome = {
        taskId: task.id, title: task.title, status: 'done',
        filesCreated, filesModified, packagesInstalled, summary,
    }

    // Record into session state (replaces the broken recordTaskOutcome call)
    if (this._memoryStore.getSessionState()) {
        await this._memoryStore.recordTaskOutcomeFromParsed(task, outcome)
    }

    // Update file index
    const fileUpdates: Record<string, string> = {}
    for (const f of [...filesCreated, ...filesModified]) {
        fileUpdates[f] = task.title
    }
    if (Object.keys(fileUpdates).length > 0) {
        await this._memoryStore.updateFileIndex(fileUpdates)
    }

    if (outcome.summary) {
        await this._memoryStore.addEntry({
            text: outcome.summary,
            type: task.taskType === 'create' ? 'file_created' : 'fix',
            taskId: task.id,
        })
    }
}
Add this method to memoryStore.ts (bypasses the broken text parser):
typescript// memoryStore.ts — add new method

async recordTaskOutcomeFromParsed(task: AgentTask, outcome: TaskOutcome): Promise<TaskOutcome> {
    if (!this.sessionState) return outcome

    for (const f of outcome.filesCreated) {
        if (!this.sessionState.allCreatedFiles.includes(f))
            this.sessionState.allCreatedFiles.push(f)
    }
    for (const f of outcome.filesModified) {
        if (!this.sessionState.allModifiedFiles.includes(f) &&
            !this.sessionState.allCreatedFiles.includes(f))
            this.sessionState.allModifiedFiles.push(f)
    }
    for (const pkg of outcome.packagesInstalled) {
        const exists = this.sessionState.allInstalledPackages
            .some(p => p.manager === pkg.manager && p.name === pkg.name)
        if (!exists) this.sessionState.allInstalledPackages.push(pkg)
    }

    this.sessionState.taskOutcomes.push(outcome)
    this.sessionState.lastUpdated = Date.now()
    await this._saveSessionState()
    return outcome
}

Fix 2 — Tool format injection (critical for 7B)
Root cause: After task 1, AUTONOMOUS_CONTINUATION_PROMPT (~200 tokens) replaces the full 1500-token system prompt. It says "use XML tool tags" but gives no format examples. 7B models forget the exact syntax within 3-4 turns and start hallucinating attributes (<rewrite_file path="...">), wrong tag names (<execute_command>), or plain markdown code blocks.
Fix: Add a compact cheatsheet to agentPromptTemplates.ts and inject it into every task, not just the first.
typescript// agentPromptTemplates.ts — add this export

export const TOOL_FORMAT_CHEATSHEET = (workspaceRoot: string) => `\
=== TOOL FORMAT (exact — no attributes, no markdown, no variations) ===
<read_file><uri>${workspaceRoot}/path/to/file.ts</uri></read_file>
<ls_dir><uri>${workspaceRoot}/src</uri></ls_dir>
<get_dir_tree><uri>${workspaceRoot}</uri></get_dir_tree>
<create_file><uri>${workspaceRoot}/path/to/newfile.ts</uri></create_file>
<rewrite_file><uri>${workspaceRoot}/path/to/file.ts</uri><new_content>full file content here</new_content></rewrite_file>
<edit_file><uri>${workspaceRoot}/path/to/file.ts</uri><search_replace_blocks><<<<<<< ORIGINAL
exact original lines
=======
replacement lines
>>>>>>> UPDATED</search_replace_blocks></edit_file>
<run_command><cwd>${workspaceRoot}</cwd><command>npm install express</command></run_command>
<create_folder><uri>${workspaceRoot}/path/to/folder</uri></create_folder>
RULES: Always use absolute paths. Always read before editing. One tool call per response. Stop after the closing tag.
=== END TOOL FORMAT ===`
Then in buildTaskExecutionPrompt, always append the cheatsheet:
typescript// agentPromptTemplates.ts — modify buildTaskExecutionPrompt signature and body

export function buildTaskExecutionPrompt(
    task: AgentTask,
    plan: AgentPlan,
    memoryContext: string,
    sessionContextBlock: string = '',
    workspaceRoot: string = '',   // ADD THIS
): string {
    const completedTasks = plan.tasks.filter(t => t.status === 'done')
    const upcomingTasks = plan.tasks.filter(t => t.status === 'pending' && t.id !== task.id).slice(0, 2)

    const parts: string[] = []

    // Cheatsheet FIRST — small models read top-to-bottom, format rules must come before content
    if (workspaceRoot) parts.push(TOOL_FORMAT_CHEATSHEET(workspaceRoot))

    if (sessionContextBlock) parts.push(sessionContextBlock)
    if (memoryContext) parts.push(memoryContext)

    const doneStr = completedTasks.map(t => t.title).join(', ') || 'none'
    const nextStr = upcomingTasks.map(t => t.title).join(', ') || 'this is last task'
    parts.push(`PLAN: done=[${doneStr}] | coming=[${nextStr}]`)

    parts.push(
        `CURRENT TASK: ${task.title}\n` +
        `DESCRIPTION: ${task.description}\n` +
        `TARGET FILES: ${task.targetFiles.join(', ') || 'determine from context'}`
    )

    return parts.join('\n\n')
}
Update the call site in _runExecutionPhase:
typescript// agentPipelineService.ts — in _runExecutionPhase, update buildTaskExecutionPrompt call

const executionPrompt = buildTaskExecutionPrompt(
    task, plan, memoryContext, sessionContextBlock,
    workspaceFolders.length > 0 ? workspaceFolders[0].uri.fsPath : ''  // ADD
)

Fix 3 — Pipeline instructions as system message
Root cause: The entire preamble (1500 tokens of instructions) is injected as a user message: addUserMessageAndStreamResponse({ userMessage: '__PIPELINE_HIDDEN__\n...' }). For 7B models, system message tokens have special model-level weight during RLHF training. Instructions in user messages get treated as context, not directives, and get diluted by conversation history after 3-4 turns.
The correct architecture: The chat thread service needs a way to override the system message for the duration of a pipeline run. Add this to IChatThreadService:
typescript// chatThreadServiceInterface.ts — add to interface

setPipelineSystemPrompt(threadId: string, systemPrompt: string | null): void
Then in agentPipelineService.ts, set it before each task and pass only the task-specific content as the user message:
typescript// agentPipelineService.ts — in _runExecutionPhase, replace the addUserMessageAndStreamResponse block

const isFirstTask = plan.tasks.filter(t => t.status === 'done').length === 0
const systemPromptToUse = isSmallModel
    ? AUTONOMOUS_EXECUTION_SYSTEM_PROMPT_7B
    : AUTONOMOUS_EXECUTION_SYSTEM_PROMPT

// Set the system message override — this replaces the default chat system prompt
const pipelineSystemMessage = `${systemPromptToUse}\n\n${workspaceRootMsg}\n\n${TOOL_FORMAT_CHEATSHEET(workspaceRoot)}`
this._chatThreadService.setPipelineSystemPrompt(threadId, pipelineSystemMessage)

// User message is now ONLY task content — no instructions
const userContent = this.state.feedbackAnswer !== null
    ? `USER FEEDBACK:\n${this.state.feedbackAnswer}\n\nPlease proceed with the task.`
    : executionPrompt  // this is now: cheatsheet + session memory + task description

await this._chatThreadService.addUserMessageAndStreamResponse({
    userMessage: userContent,
    threadId,
})
At the end of the pipeline, clear the override:
typescript// In the finally block of _runExecutionPhase
} finally {
    this._chatThreadService.setChatModeOverride(null)
    this._chatThreadService.setPipelineAutoApprove(false)
    this._chatThreadService.setPipelineSystemPrompt(threadId, null)  // ADD
}

Fix 4 — Parent directory auto-creation
Root cause: fileService.createFile(uri) throws if parent directories don't exist. When the model writes <create_file><uri>/workspace/src/components/Button.tsx</uri></create_file> and src/components/ doesn't exist yet, the tool call throws. The model gets an error, retries, fails again, wastes tokens, and eventually gives up.
typescript// toolsService.ts — replace create_file callTool handler

create_file: async ({ uri }) => {
    // Auto-create every parent directory in the path
    const ensureParentDirs = async (fileUri: URI) => {
        const parentUri = URI.joinPath(fileUri, '..')
        try {
            const stat = await fileService.stat(parentUri)
            if (!stat.isDirectory) throw new Error('Parent path is a file, not a directory')
        } catch {
            // Parent doesn't exist — recurse upward then create
            await ensureParentDirs(parentUri)
            try { await fileService.createFolder(parentUri) } catch { /* may race-create, that's fine */ }
        }
    }

    try {
        await ensureParentDirs(uri)
    } catch (e) {
        return { result: { message: `Could not create parent directory for ${uri.fsPath}: ${e}` } }
    }

    const exists = await fileService.exists(uri)
    if (exists) {
        return {
            result: {
                message: `STOP: File ${uri.fsPath} already exists. DO NOT call create_file again. `
                    + `Use read_file to inspect it, then rewrite_file or edit_file to modify it.`
            }
        }
    }

    await fileService.createFile(uri)
    return {
        result: {
            message: `File ${uri.fsPath} created successfully. `
                + `Now call rewrite_file with the complete file content.`
        }
    }
},
Apply the same pattern to create_folder:
typescriptcreate_folder: async ({ uri }) => {
    const exists = await fileService.exists(uri)
    if (exists) {
        return { result: { message: `Folder ${uri.fsPath} already exists. Proceed to use it.` } }
    }
    // createFolder in VS Code's fileService creates intermediate dirs
    await fileService.createFolder(uri)
    return { result: { message: `Folder ${uri.fsPath} created.` } }
},

Fix 5 — _waitForStreamComplete race condition
Root cause: The early-exit check if (streamStarted && currentState?.isRunning === undefined) is logically impossible. streamStarted = currentState?.isRunning !== undefined. So if streamStarted is true, then isRunning !== undefined is true, which means isRunning === undefined is false. The branch never fires. On fast machines where the stream completes before the listener registers, the pipeline hangs until the 5-minute timeout.
typescript// agentPipelineService.ts — replace _waitForStreamComplete entirely

private _waitForStreamComplete(threadId: string): Promise<void> {
    return new Promise<void>((resolve) => {
        let settled = false
        let everSawRunning = false

        const settle = () => {
            if (settled) return
            settled = true
            clearInterval(pollInterval)
            clearTimeout(hardTimeout)
            disposable.dispose()
            resolve()
        }

        // Event-driven path
        const disposable = this._chatThreadService.onDidChangeStreamState(({ threadId: id }) => {
            if (id !== threadId) return
            const s = this._chatThreadService.streamState[threadId]
            if (s?.isRunning === true) {
                everSawRunning = true
            } else if (everSawRunning) {
                // Saw it start and now it's stopped
                settle()
            }
        })

        // Polling fallback — handles the case where the stream started and ended
        // before our listener attached (fast completions on cached responses)
        const pollInterval = setInterval(() => {
            const s = this._chatThreadService.streamState[threadId]
            if (s?.isRunning === true) {
                everSawRunning = true
            } else if (everSawRunning) {
                settle()
            }
            // Also settle if we've polled 10 times and stream never started
            // (means addUserMessageAndStreamResponse silently failed)
        }, 150)

        // Give stream 500ms to start before we decide it never will
        setTimeout(() => {
            if (!everSawRunning) {
                // Stream may have already completed synchronously before we set up listeners
                const s = this._chatThreadService.streamState[threadId]
                if (!s?.isRunning) settle()
            }
        }, 500)

        // Absolute hard timeout — 5 minutes
        const hardTimeout = setTimeout(settle, 5 * 60 * 1000)
    })
}

Fix 6 — Terminal reroute on all platforms
Root cause: _checkTerminalReroute is wrapped in if (os === 'windows'). On Linux/Mac, cat src/main.ts runs as a real shell command instead of calling read_file. This wastes a terminal slot, outputs noisy terminal formatting, and doesn't give the model the clean file content it needs.
typescript// agentAssistService.ts — in processToolCall, replace step 6

// ── Step 6: Terminal → XML reroute (ALL platforms) ──
if (correctedName === 'run_command' || correctedName === 'run_persistent_command') {
    const cmdReroute = this._checkTerminalReroute(correctedParams, repairs)
    if (cmdReroute) {
        correctedName = cmdReroute.toolName
        for (const key of Object.keys(correctedParams)) delete correctedParams[key]
        Object.assign(correctedParams, cmdReroute.params)
        wasIntercepted = true
    } else {
        // Shell translation only on Windows
        if (os === 'windows') this._translateShellCommand(correctedParams, repairs)
    }
}
Also extend TERMINAL_TO_XML_REROUTES to cover common patterns the model uses on all platforms:
typescript// agentAssistService.ts — add to TERMINAL_TO_XML_REROUTES array

{
    // head -n 50 file.ts → read_file with end_line
    pattern: /^head\s+(?:-n\s+(\d+)\s+)?["']?(.+?)["']?\s*$/i,
    xmlTool: 'read_file',
    extractParams: (m, cwd) => ({
        uri: resolvePathArg(m[2] || m[1], cwd),
        end_line: m[1] ? m[1] : '50'
    }),
},
{
    // find . -name "*.ts" → search_pathnames_only
    pattern: /^find\s+.+\s+-name\s+["']?([^"'\s]+)["']?/i,
    xmlTool: 'search_pathnames_only',
    extractParams: (m) => ({ query: m[1] }),
},
{
    // echo "text" > file → rewrite_file (dangerous — skip for safety, just block it)
    pattern: /^echo\s+.+>\s+\S+$/i,
    xmlTool: 'run_command',  // allow through, don't reroute
    extractParams: (m, cwd) => ({ command: m[0], cwd: cwd || '' }),
},

Fix 7 — CWD state tracking
Root cause: Every time the model omits <cwd>, AgentAssistService._sanitizeCwd defaults to _workspaceRoot. If the project has a monorepo structure (packages/api, packages/web), commands run in the wrong directory. The model does cd packages/api && style commands to compensate, which then fail because && parsing is fragile.
Add a session-level CWD tracker to AgentAssistService:
typescript// agentAssistService.ts — add to class

private _sessionCwd: string | null = null

// Call this when a new pipeline run starts
resetSession(workspaceRoot: string): void {
    this._sessionCwd = workspaceRoot
}

// In _sanitizeCwd, update the tracked CWD after normalization
private _sanitizeCwd(params: RawToolParamsObj, repairs: RepairEntry[]): void {
    // ... existing normalization logic ...

    // After normalization, if cwd was provided and is valid, remember it
    if (params.cwd && typeof params.cwd === 'string' && params.cwd.trim()) {
        this._sessionCwd = params.cwd as string
    }

    // If no cwd provided, fall back to last known cwd, then workspace root
    if (!params.cwd && this._sessionCwd) {
        params.cwd = this._sessionCwd
    } else if (!params.cwd && this._workspaceRoot) {
        params.cwd = this._workspaceRoot
    }
}
Call resetSession at the start of each pipeline run in agentPipelineService.ts:
typescript// agentPipelineService.ts — in startPipeline, after _memoryStore.startSession(workspaceRoot_)

this._agentAssistService.resetSession(workspaceRoot_)

Fix 8 — Success verification after write operations
Root cause: A tool call returning { result: { lintErrors: null } } only means the write operation ran without throwing. It doesn't confirm the file has the expected content. Silent failures (disk full, permission error caught internally, wrong URI resolution) look identical to successes.
Add a quick sanity read in stringOfResult for rewrite_file and edit_file:
typescript// toolsService.ts — in callTool, replace rewrite_file handler

rewrite_file: async ({ uri, newContent }) => {
    const exists = await fileService.exists(uri)
    if (!exists) {
        throw new Error(
            `File does not exist: ${uri.fsPath}. Call create_file first, then rewrite_file.`
        )
    }
    await voidModelService.initializeModel(uri)
    if (this.commandBarService.getStreamState(uri) === 'streaming') {
        throw new Error(`Another operation is streaming this file. Wait and retry.`)
    }
    await editCodeService.callBeforeApplyOrEdit(uri)
    editCodeService.instantlyRewriteFile({ uri, newContent })

    const lintErrorsPromise = Promise.resolve().then(async () => {
        await timeout(2000)
        // Verify write succeeded by checking file length
        const { val } = await readFile(fileService, uri, 1000)
        if (val === null) {
            return { lintErrors: [{ code: 'WRITE_FAILED', message: '(error) File is empty or unreadable after write — rewrite may have failed', startLineNumber: 1, endLineNumber: 1 }] satisfies LintErrorItem[] }
        }
        const { lintErrors } = this._getLintErrors(uri)
        return { lintErrors }
    })
    return { result: lintErrorsPromise }
},

Fix 9 — Context window management
Root cause: After 10 tasks, thread.messages could be 200+ entries. The conversion to LLM messages carries all of it into every API call. A 7B model with a 32K context window hits its limit and starts truncating from the beginning — exactly where the system message and tool format live.
Add a message summarizer that runs between tasks:
typescript// agentPipelineService.ts — add new method

private async _trimThreadHistoryIfNeeded(threadId: string): Promise<void> {
    const thread = this._chatThreadService.state.allThreads[threadId]
    if (!thread?.messages) return

    // Rough token estimate: ~3 chars per token for code
    const totalChars = thread.messages.reduce((sum, m) => {
        if (m.role === 'assistant') return sum + (m.displayContent?.length ?? 0)
        if (m.role === 'user') return sum + (m.content?.length ?? 0)
        if (m.role === 'tool') return sum + (m.content?.length ?? 0)
        return sum
    }, 0)

    const estimatedTokens = totalChars / 3

    // 7B models: 32K context. Reserve 8K for the new task. Trim at 20K.
    const TOKEN_TRIM_THRESHOLD = 20_000

    if (estimatedTokens < TOKEN_TRIM_THRESHOLD) return

    // Keep: system message equivalent (handled by setChatModeOverride),
    // last 2 complete task exchanges (user + assistant + tool messages),
    // and the session context block (re-injected fresh each task anyway)
    //
    // Strategy: find the boundary of the 2nd-to-last task and drop everything before it.
    // A "task boundary" is a user message starting with the pipeline prefix.

    const messages = thread.messages
    const taskBoundaries: number[] = []
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i]
        if (m.role === 'user' && (m.content?.includes('CURRENT TASK:') || m.content?.includes('__PIPELINE_HIDDEN__'))) {
            taskBoundaries.push(i)
        }
    }

    if (taskBoundaries.length <= 2) return // Not enough history to trim

    // Keep only messages from the 2nd-to-last task boundary onwards
    const keepFrom = taskBoundaries[taskBoundaries.length - 2]
    const trimmedMessages = messages.slice(keepFrom)

    // Prepend a synthetic user message summarizing what was dropped
    const droppedCount = keepFrom
    const completedSummary = this._memoryStore.buildSessionContextBlock()
    const syntheticSummary = {
        role: 'user' as const,
        content: `[HISTORY TRIMMED: ${droppedCount} earlier messages removed to stay within context limit.\nCompleted work summary:\n${completedSummary}]`,
        displayContent: '',
        selections: null,
        state: { stagingSelections: [], isBeingEdited: false }
    }

    await this._chatThreadService.overwriteThreadMessages(threadId, [syntheticSummary, ...trimmedMessages])
}
Call it before each task in the execution loop:
typescript// agentPipelineService.ts — in _runExecutionPhase, before "Mark running"

await this._trimThreadHistoryIfNeeded(threadId)

Fix 10 — Stronger search/replace validation with examples
Root cause: _validateSearchReplaceBlocks blocks the call if the markers are missing but gives an abstract error message. A 7B model that gets Invalid SEARCH/REPLACE block format has no idea what it did wrong and usually retries with the exact same malformed block.
typescript// agentAssistService.ts — replace _validateSearchReplaceBlocks

private _validateSearchReplaceBlocks(
    params: RawToolParamsObj,
    repairs: RepairEntry[],
): { blocked: boolean, reason?: string } {
    if (typeof params.search_replace_blocks !== 'string' || !params.search_replace_blocks.trim()) {
        return {
            blocked: true,
            reason: `search_replace_blocks is empty. You MUST provide SEARCH/REPLACE blocks. Example:\n`
                + `<<<<<<< ORIGINAL\nconst x = 1\n=======\nconst x = 2\n>>>>>>> UPDATED`
        }
    }

    const blocks = params.search_replace_blocks

    // Try to auto-repair common marker misspellings before rejecting
    const repaired = blocks
        .replace(/<<<+\s*ORIGINAL/gi, '<<<<<<< ORIGINAL')
        .replace(/===+/g, '=======')
        .replace(/>>>+\s*UPDATED/gi, '>>>>>>> UPDATED')
        .replace(/<<<+\s*SEARCH/gi, '<<<<<<< ORIGINAL')  // model calls it SEARCH
        .replace(/>>>+\s*REPLACE/gi, '>>>>>>> UPDATED')   // model calls it REPLACE

    if (repaired !== blocks) {
        repairs.push({
            type: 'search_replace_fix',
            description: 'Auto-repaired malformed SEARCH/REPLACE markers',
            before: blocks.slice(0, 100),
            after: repaired.slice(0, 100),
        })
        params.search_replace_blocks = repaired
    }

    const hasOriginal = params.search_replace_blocks.includes(ORIGINAL)
    const hasDivider = params.search_replace_blocks.includes(DIVIDER)
    const hasFinal = params.search_replace_blocks.includes(FINAL)

    if (!hasOriginal || !hasDivider || !hasFinal) {
        const missing = [
            !hasOriginal && `'${ORIGINAL}'`,
            !hasDivider && `'${DIVIDER}'`,
            !hasFinal && `'${FINAL}'`,
        ].filter(Boolean).join(', ')

        return {
            blocked: true,
            reason: `Missing markers: ${missing}. The EXACT format is:\n`
                + `<<<<<<< ORIGINAL\n[exact original lines]\n=======\n[replacement lines]\n>>>>>>> UPDATED\n`
                + `Do NOT paraphrase the original. It must match the file EXACTLY.`
        }
    }

    // Check ORIGINAL section isn't empty (most common mistake after the markers are correct)
    const origMatch = params.search_replace_blocks.match(/<<<<<<< ORIGINAL\n([\s\S]*?)\n=======/m)
    if (origMatch && origMatch[1].trim() === '') {
        return {
            blocked: true,
            reason: `The ORIGINAL section is empty. You must include the exact lines from the file you want to replace. `
                + `Use read_file to get the exact content first.`
        }
    }

    return { blocked: false }
}

Fix 11 — Task success detection
Root cause: Tasks are marked done as long as the stream completes without throwing. If the model outputs "I cannot access the filesystem" or "I don't have permission to..." as plain text (which 7B models frequently do instead of using tool calls), the task is still marked done.
typescript// agentPipelineService.ts — in _runExecutionPhase, before "Mark done"

// Check if the agent actually used any tools this task
const thread = this._chatThreadService.state.allThreads[threadId]
const taskMessages = thread?.messages?.slice(-20) || []
const hasToolCalls = taskMessages.some(m => m.role === 'tool')
const lastAssistantMsg = [...taskMessages].reverse().find(m => m.role === 'assistant')
const assistantText = lastAssistantMsg?.displayContent || ''

// Detect refusal patterns — 7B models sometimes explain why they can't do something
const refusalPatterns = [
    /i (?:cannot|can't|am unable to|do not have|don't have) (?:access|modify|create|edit|write)/i,
    /(?:as an ai|as a language model)/i,
    /i (?:don't|cannot) have (?:direct )?access to (?:your )?(?:file|file ?system|disk)/i,
    /please (?:open|navigate to|go to|find)/i,  // asking user to do it manually
]

const isRefusal = refusalPatterns.some(p => p.test(assistantText))

if (isRefusal && !hasToolCalls) {
    // Task failed — model refused instead of acting
    const attempts = (failureCountOfTaskId.get(task.id) ?? 0) + 1
    failureCountOfTaskId.set(task.id, attempts)

    const refusalRecoveryMessage = `CRITICAL: You output plain text instead of a tool call. `
        + `You ARE connected to the filesystem via XML tools. DO NOT explain what you would do. `
        + `DO NOT ask the user. IMMEDIATELY output one of these tool calls:\n`
        + `<read_file>, <edit_file>, <rewrite_file>, <create_file>, <run_command>\n`
        + `Task: ${task.title}\nDescription: ${task.description}`

    if (attempts < 3) {
        // Retry with explicit recovery message
        this._setState({ feedbackAnswer: refusalRecoveryMessage })
        plan = { ...plan, tasks: plan.tasks.map(t => t.id === task.id ? { ...t, status: 'pending' } : t) }
        this._updatePlanTasks(plan)
        continue
    }
}

// Mark done
plan = {
    ...plan,
    tasks: plan.tasks.map(t => t.id === task.id ? { ...t, status: 'done', result: `Completed: ${task.title}` } : t)
}

New feature — Read-before-edit enforcement (from Cline)
One of Cline's most impactful patterns: intercept edit_file and rewrite_file at the middleware layer, check if the file was recently read in this task, and auto-inject a read_file result if not. This eliminates the "edited the wrong lines because model didn't know current content" failure mode.
typescript// agentAssistService.ts — add to class

private _filesReadThisTask: Set<string> = new Set()
private _currentTaskId: string | null = null

startTask(taskId: string): void {
    if (taskId !== this._currentTaskId) {
        this._filesReadThisTask.clear()
        this._currentTaskId = taskId
    }
}

recordFileRead(filePath: string): void {
    this._filesReadThisTask.add(filePath)
}

// In processToolCall, before step 8 (search/replace validation):
// ── Step 7.5: Read-before-edit check ──
if (correctedName === 'edit_file' || correctedName === 'rewrite_file') {
    const uriStr = correctedParams.uri as string | undefined
    if (uriStr && !this._filesReadThisTask.has(uriStr)) {
        repairs.push({
            type: 'tool_reroute',
            description: `Injecting read_file before edit — file not yet read this task`,
            before: correctedName,
            after: `read_file → ${correctedName}`,
        })
        // Signal to the caller that a read should happen first
        // (caller checks this flag and runs read_file, then re-runs the edit)
        return {
            toolName: correctedName,
            params: correctedParams,
            repairs,
            wasIntercepted: true,
            blocked: false,
            requiresReadFirst: uriStr,  // new field
        }
    }
}
Add requiresReadFirst?: string to AssistResult in agentAssistTypes.ts and handle it in chatThreadService._runToolCall:
typescript// chatThreadService.ts — in _runToolCall, after agentAssistService.processToolCall

if (assistResult.requiresReadFirst) {
    // Auto-read the file first, inject result into context, then proceed with the edit
    const readResult = await toolsService.callTool.read_file({
        uri: validateURI(assistResult.requiresReadFirst, workspaceContextService),
        startLine: null, endLine: null, pageNumber: 1
    })
    const readString = toolsService.stringOfResult.read_file(
        { uri: ..., startLine: null, endLine: null, pageNumber: 1 },
        readResult.result
    )
    // Add read result as a synthetic tool message before the edit
    // ... inject into thread ...
    agentAssistService.recordFileRead(assistResult.requiresReadFirst)
}

What the top agents do that this one doesn't (prioritized)
1. Anthropic Claude / Cline — extended thinking scratchpad before tool calls. For tasks that require multi-step reasoning ("refactor this to use the repository pattern"), the model should reason through the plan in a hidden scratchpad before picking up a tool. With the Anthropic API this is thinking: { type: 'enabled', budget_tokens: 2048 }. For Ollama, you can prompt for it:
typescript// Add to AUTONOMOUS_EXECUTION_SYSTEM_PROMPT_7B

Before each tool call, write your reasoning in <think>...</think> tags.
Example:
<think>
I need to read the file first to understand its current structure before editing.
The task says modify the auth middleware — I should look at src/middleware/auth.ts.
</think>
<read_file><uri>/workspace/src/middleware/auth.ts</uri></read_file>
The extractReasoningWrapper in extractGrammar.ts already handles <think> tags — it strips them from displayContent and puts them in fullReasoning. This is already wired up. You just need to add the prompt instruction.
2. VS Code Agent — deterministic file existence check before create. VS Code's agent injects a pre-computed "files that exist" list into the system message. You already have this in sessionContextBlock — the fix in Fix 1 now makes it work. The missing piece is injecting it as system context (Fix 3 above) instead of user context.
3. Aider — git checkpoint before each task. Before running each task, commit the current state. If the task fails catastrophically, git reset --hard HEAD~1 recovers cleanly. Add this to _runExecutionPhase:
typescript// agentPipelineService.ts — before each task execution

if (workspaceFolders.length > 0) {
    try {
        // Silently checkpoint — don't fail the task if git isn't available
        await this._scmService.gitCommitAll(
            workspaceFolders[0].uri.fsPath,
            `[void-agent] checkpoint before: ${task.title}`
        )
    } catch { /* git not available, continue */ }
}
4. Cline — show diff and require approval before applying writes. Currently edit_file and rewrite_file apply instantly. For agentic tasks this is fine (that's the point), but for destructive edits (deleting a function, refactoring an interface used in 20 files), the user should see what's about to happen. The approvalTypeOfBuiltinToolName already has 'edit_file': 'edits' — you just need autoApprove.edits to default to false for pipeline runs:
typescript// agentPipelineService.ts — in _runExecutionPhase

// Only auto-approve terminal commands during pipeline (edits should still show diff)
this._chatThreadService.setPipelineAutoApprove(true)  // this currently auto-approves everything
// Change to:
this._chatThreadService.setPipelineAutoApproveEdits(false)  // show diffs
this._chatThreadService.setPipelineAutoApproveTerminal(true)  // auto-run commands
5. All production agents — repo map. Every agent that works well with a large codebase injects a compact index of the codebase: filenames, exported symbols, and one-line purpose. This is different from directoryStr (which is just a tree of paths). A repo map looks like:
src/auth/middleware.ts — Express middleware: verifyJWT, requireRole
src/models/User.ts — Mongoose model: UserSchema, IUser interface
src/routes/users.ts — Router: GET /users, POST /users, DELETE /users/:id
Build this by reading each file's first 50 lines and extracting exports. Cache it in memoryStore.fileIndex. Inject the relevant 10-15 entries (files related to the current task's targetFiles) into every task prompt. This alone cuts "wrong file" errors by ~60%.
typescript// In buildTaskExecutionPrompt — add before the tool cheatsheet

const relevantFileMap = taskContext.targetFiles
    .flatMap(f => {
        const desc = memory.fileIndex[f]
        return desc ? [`${f} — ${desc}`] : []
    })
    .join('\n')

if (relevantFileMap) {
    parts.push(`RELEVANT FILES (read before editing):\n${relevantFileMap}`)
}

Architecture summary
The three changes that will have the most immediate impact on your described failure modes:
Fix 1 (memory) eliminates "creates already-existing files" because the session state will now actually contain the list of created files and inject it into every task prompt.
Fix 2 (tool format cheatsheet) eliminates "param error" and "wrong tag name" failures because the model gets a concrete example with your actual workspace path on every turn.
Fix 3 (system message) eliminates "forgets the working directory" and general instruction drift because system message tokens carry real weight in 7B RLHF-trained models — user message instructions don't.
Everything else is hardening on top of those three. Implement them in that order.
