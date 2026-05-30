# Void Agent Plan v3 — Complete Reference
### RTX 3050 4GB VRAM · Qwen 2.5 Coder (Ollama) · Local-Only · No Over-Engineering

---

## What Changed in v3 (Delta from v2)

| Change | Verdict | Section |
|--------|---------|---------|
| Editable Plan & Task List | ✅ Added | Addition 10 |
| Per-Phase Model Selection | ✅ Added | Addition 11 |
| Model recommendations updated (user runs 7b) | ✅ Updated | Part 0 |
| All v2 content | ✅ 100% preserved | All other sections |

---

## v3 New Ideas — Brutal Evaluation First

### Idea 1: Editable Plan & Task List

**Verdict: ACCEPT ✅ — Not over-engineering.**

What it actually is technically: a form/textarea over the existing `AgentPlan` JSON object + a
Save button that validates and replaces it. The execution phase already reads from `currentPlan`.
After save → zero changes needed to Phase 2. This is the cheapest addition in this entire plan.

**Why it's genuinely good:**

The 7b model is okay at code generation but planning is its real weakness — it
misses edge cases, puts too many files in one task, creates bad dependency chains.
The edit feature compensates for this directly. User can:
1. Let 7b generate a rough draft plan
2. Copy it to Gemini
3. Get a much better plan back
4. Paste it in, execute locally

This is a hybrid workflow that costs nothing in API fees for the heavy execution,
and gets cloud-quality planning. That's a real win.

**Honest limitations:**
- If user pastes a badly structured plan from Gemini (wrong field names, wrong file paths,
  circular dependencies), validation must catch it hard before execution. This is the one
  thing that can go wrong. Build the validator carefully.
- The editor needs to survive invalid JSON gracefully — don't crash the panel.

**Implementation cost: ~3 hours. Not optional. Add it.**

---

### Idea 2: Per-Phase Model Selection

**Verdict: ACCEPT ✅ — Not over-engineering.**

What it actually is: `GET http://localhost:11434/api/tags` (one fetch call) to list installed
models. Two dropdowns in the agent panel. Two extra fields in `AGENT_DEFAULTS`. ~50 lines.

**Why it's genuinely good:**

Planning runs ONCE per session. Paying 20 seconds on a 7b model for planning is fine.
Execution runs 6-10 times per session. Using a 3b model there cuts per-task latency by 4x.
The user already identified this: "for planning we couldn't use qwen" — they want a
stronger model for planning (could be a bigger local model, or they can skip local planning
entirely with the editable plan → Gemini workflow).

**Honest limitations:**
- If user selects 7b for both phases, execution will be slow (2-4 tok/sec per task,
  potentially 60-90 seconds per task). That's their call to make — the dropdown makes
  the tradeoff explicit.
- No validation that the selected model is actually good at the task. Just surfacing
  installed models; user decides.

**Implementation cost: ~1.5 hours. Add it.**

---

## Part 0: Model Reality Check (Updated for v3)

The user is running `qwen2.5-coder:7b` on RTX 3050 4GB VRAM. It works but CPU-spills
some layers, which makes it slow. Here is the honest picture:

| Model | VRAM (Q4_K_M) | Fits 4GB? | Speed on 3050 | Best Role |
|---|---|---|---|---|
| qwen2.5-coder:7b | ~4.4 GB | ⚠️ CPU spill | 2–5 tok/sec | Planning (once per session — slow is OK) |
| qwen2.5-coder:3b | ~1.9 GB | ✅ Comfortable | 15–20 tok/sec | Execution (runs 6-10 times per session) |
| phi4-mini:3.8b | ~2.3 GB | ✅ Good | 12–16 tok/sec | Execution alternative (better JSON) |
| qwen2.5:1.5b | ~1.0 GB | ✅ Easy | 25+ tok/sec | Fast-path or planning fallback |

### v3 Recommendation: Two-Model Setup (Per-Phase)

| Phase | Default Model | Rationale |
|---|---|---|
| Phase 1 (Planning) | `qwen2.5-coder:7b` | Once per session. Slower is fine. Better reasoning. |
| Phase 2 (Execution) | `qwen2.5-coder:3b` | Runs many times. Speed matters. Task = structured code. |

User overrides both via the model selector (Addition 11). No code changes needed to swap.

**The best-possible planning strategy (if you want Gemini-quality plans):**
Use Addition 10's "Copy for AI" workflow. Let local 7b generate a rough plan,
copy to Gemini, get a refined plan, paste back. Phase 2 executes the Gemini plan
with local 3b. Zero cloud costs for execution. Best of both worlds.

---

## Full Architecture v3

```
User types prompt
       │
       ▼
 [WORKSPACE FINGERPRINT]  ← runs once per session
  detect: framework, style, structure, existing files
       │
       ▼
╔══════════════════════════════════════════╗
║           PHASE 1: PLANNING              ║
║  Model: [planning model, default: 7b]   ║  ← Addition 11
╠══════════════════════════════════════════╣
║  Step 1: Prompt Refinement (JSON)        ║
║  Step 2: Task List Generation            ║
║  Step 3: Task size check →               ║
║          auto-split if too large         ║
╚══════════════════════════════════════════╝
       │
       ▼
╔══════════════════════════════════════════╗
║          PLAN REVIEW PANEL               ║  ← NEW in v3
╠══════════════════════════════════════════╣
║  Shows: refined prompt + numbered tasks  ║
║                                          ║
║  [✏️ Edit Plan]  [📋 Copy for AI]        ║
║  [✅ Approve & Execute]                  ║
╚══════════════════════════════════════════╝
         │
  user clicks "Edit Plan"?
         │
         ▼
╔══════════════════════════════════════════╗
║          PLAN EDITOR PANEL               ║  ← Addition 10
╠══════════════════════════════════════════╣
║  Tab 1: Edit Tasks                       ║
║   - Each task: title, desc, files fields ║
║   - Add task / delete task / reorder     ║
║  Tab 2: Paste from AI                    ║
║   - Textarea for JSON from Gemini        ║
║   - [Validate] [Use This Plan]           ║
║  [Save Changes] → validates → updates    ║
╚══════════════════════════════════════════╝
       │
       ▼ (approved plan, possibly edited)
╔══════════════════════════════════════════╗
║           PHASE 2: EXECUTION             ║
║  Model: [execution model, default: 3b]  ║  ← Addition 11
╠══════════════════════════════════════════╣
║  For each task:                          ║
║  1. Pre-execution validation             ║
║  2. Snapshot files (rollback)            ║
║  3. Load memory context                  ║
║  4. Execute task (streaming)             ║
║  5. Parse output (with retry)            ║
║  6. Show diff preview                    ║
║  7. User confirm → Apply                 ║
║  8. Update memory                        ║
║  9. Mark task done ✓                     ║
╚══════════════════════════════════════════╝
       │
  task fails twice?
       │
       ▼
╔══════════════════════════════════════════╗
║          RE-PLANNING PHASE               ║
║  Collect: error + file state             ║
║  Re-ask planner: fix task subset         ║
║  Inject: what failed + why               ║
╚══════════════════════════════════════════╝
       │
       ▼
Continue or user takes over manually
```

---

## Addition 1: Re-Planning Loop [from v2 — KEPT INTACT]

### When it triggers
A re-plan is NOT a full restart. It only replaces the failed task and any of its dependents.
First failure = retry same task. Second failure = re-plan that task + dependents.

### Types and interfaces

```typescript
// agentPipeline.ts — add to executeTask() wrapper

interface FailureContext {
  taskId: string;
  attempts: number;
  lastError: string;
  fileStateAtFailure: Record<string, string>; // actual file contents
}

async function handleTaskFailure(
  task: AgentTask,
  ctx: FailureContext,
  plan: AgentPlan
): Promise<AgentTask[]> {

  if (ctx.attempts < 2) {
    return [];  // empty = retry existing task
  }

  // Second failure: trigger re-plan for this task + its dependents
  const affectedTasks = getTaskAndDependents(task.id, plan.tasks);
  const replanPrompt = buildReplanPrompt(task, ctx, affectedTasks);

  const response = await plannerModel.complete({
    system: REPLAN_SYSTEM_PROMPT,
    user: replanPrompt,
    responseFormat: 'json'
  });

  const newTasks = JSON.parse(response).replacementTasks;
  return newTasks;
}
```

### Re-plan system prompt

```typescript
// promptTemplates.ts
export const REPLAN_SYSTEM_PROMPT = `
You are fixing a failed coding task.
The original task did not work. Analyze the error and the actual file state,
then output 1-3 replacement tasks that achieve the same goal differently.

Rules:
- Be more conservative than the original tasks
- Each replacement task touches only ONE file
- Explain what went wrong in "diagnosis"

Output JSON only.
Schema: {
  "diagnosis": string,
  "replacementTasks": [{
    "id": "task_XXX_retry",
    "title": string,
    "description": string,
    "targetFiles": string[],
    "dependsOn": string[]
  }]
}
`;

function buildReplanPrompt(
  task: AgentTask,
  ctx: FailureContext,
  affectedTasks: AgentTask[]
): string {
  return `
FAILED TASK: ${task.title}
DESCRIPTION: ${task.description}
TARGET FILES: ${task.targetFiles.join(', ')}

ERROR THAT OCCURRED:
${ctx.lastError}

ACTUAL FILE STATE AT TIME OF FAILURE:
${Object.entries(ctx.fileStateAtFailure)
  .map(([f, c]) => `${f}:\n${c.slice(0, 500)}...`)
  .join('\n---\n')}

DOWNSTREAM TASKS THAT ALSO NEED REPLACEMENT:
${affectedTasks.map(t => `- ${t.id}: ${t.title}`).join('\n')}

Provide replacement tasks.
  `;
}
```

### Loop controller

```typescript
// In runExecutionPhase():
const failureTracker = new Map<string, number>(); // taskId → attempts

while (true) {
  const task = taskManager.getCurrentTask();
  if (!task) break;

  const attempts = failureTracker.get(task.id) ?? 0;
  failureTracker.set(task.id, attempts + 1);

  try {
    await executeTask(task);
    taskManager.markDone(task.id, result);
  } catch (error) {
    taskManager.markFailed(task.id, String(error));

    if (attempts >= 1) {
      // Second failure → re-plan
      const newTasks = await handleTaskFailure(task, {
        attempts,
        lastError: String(error),
        fileStateAtFailure: await captureFileState(task.targetFiles)
      }, plan);

      if (newTasks.length > 0) {
        taskManager.replaceTasksFrom(task.id, newTasks);
        failureTracker.clear();
      } else {
        // Re-planning returned nothing → pause, ask user
        onPauseForUserIntervention(task, String(error));
        break;
      }
    }
    // First failure: loop continues, getCurrentTask() retries same task
  }
}
```

**Why max 2 attempts before re-planning:** 1 retry handles transient model weirdness
(bad output format, etc.). Second failure means the task definition itself is broken.

---

## Addition 2: Memory with Types (Not Scoring) [from v2 — KEPT INTACT]

### Why scoring is rejected
A 3b/7b model scoring its own memories 1-10 produces random numbers. It will output
`confidence: 0.9` for both correct and wrong code. Relevance ranking needs embeddings
(more VRAM). Not worth it. Type-based filtering gives 80% of the value at 0% cost.

### Memory types and structure

```typescript
// types.ts — updated memory entry

export interface MemoryEntry {
  id: string;
  text: string;
  type: 'decision' | 'fix' | 'architecture' | 'file_created' | 'bug_found' | 'pattern';
  taskId: string;
  timestamp: number;
  // NO importance score — not reliable with small models
}

export interface ProjectMemory {
  projectSummary: string;
  techStack: string[];
  entries: MemoryEntry[];         // typed entries
  fileIndex: Record<string, string>; // filename → one-line description
  lastUpdated: number;
}
```

### Context builder with type-aware selection

```typescript
// memoryStore.ts

buildContextString(taskContext: AgentTask, maxTokens = 800): string {
  const memory = this.memory;
  const parts: string[] = [];

  // Always include (never trimmed):
  parts.push(`PROJECT: ${memory.projectSummary}`);
  parts.push(`STACK: ${memory.techStack.join(', ')}`);

  // Always include architecture decisions (last 5 max):
  const decisions = memory.entries
    .filter(e => e.type === 'decision' || e.type === 'architecture')
    .slice(-5)
    .map(e => `• ${e.text}`);
  if (decisions.length) parts.push(`KEY DECISIONS:\n${decisions.join('\n')}`);

  // Files touched by current task only:
  const relevantFiles = taskContext.targetFiles
    .filter(f => memory.fileIndex[f])
    .map(f => `${f} → ${memory.fileIndex[f]}`);
  if (relevantFiles.length) parts.push(`RELEVANT FILES:\n${relevantFiles.join('\n')}`);

  // Recent completed work (last 4 only):
  const recentWork = memory.entries
    .filter(e => e.type === 'file_created' || e.type === 'fix')
    .slice(-4)
    .map(e => `[done] ${e.text}`);
  if (recentWork.length) parts.push(`RECENT WORK:\n${recentWork.join('\n')}`);

  // After plan edit (v3 addition): inject remaining tasks as lookahead
  // (handled in Addition 10 context injection — see below)

  const full = parts.join('\n\n');
  return truncateToTokenBudget(full, maxTokens);
}
```

### Memory cleanup (simple, no scoring)

```typescript
cleanMemory(): void {
  // Always keep all 'decision' and 'architecture' entries
  // Drop oldest 'file_created' entries first
  // Keep last 20 total
  const decisions = this.memory.entries.filter(e =>
    e.type === 'decision' || e.type === 'architecture'
  );
  const others = this.memory.entries
    .filter(e => e.type !== 'decision' && e.type !== 'architecture')
    .slice(-12); // keep last 12 non-decision entries

  this.memory.entries = [...decisions, ...others];
}
```

### Local storage persistence

Memory is stored at `.void/memory.json` in the workspace root.
This survives session reloads. On new session, memory is loaded from disk.

```typescript
// memoryStore.ts — persistence

export class MemoryStore {
  private memoryPath: string; // .void/memory.json

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.memoryPath, 'utf-8');
      this.memory = JSON.parse(raw);
    } catch {
      // First run: initialize fresh
      this.memory = createEmptyMemory();
    }
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.memoryPath), { recursive: true });
    await fs.writeFile(this.memoryPath, JSON.stringify(this.memory, null, 2));
  }

  // Called after each task completes:
  async addEntry(entry: Omit<MemoryEntry, 'id' | 'timestamp'>): Promise<void> {
    this.memory.entries.push({
      ...entry,
      id: `mem_${Date.now()}`,
      timestamp: Date.now()
    });
    this.cleanMemory();
    await this.save(); // persist immediately
  }
}
```

---

## Addition 3: Pre-Execution Validation [from v2 — KEPT INTACT]

Runs before every single task. Fast — just file system checks and state checks.
No model calls.

```typescript
// validator.ts — ~60 lines

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export interface ValidationIssue {
  type: 'file_missing' | 'dependency_incomplete' | 'file_too_large' | 'schema_mismatch';
  message: string;
  autoFixable: boolean;
  suggestedFix?: string;
}

export class TaskValidator {

  async validate(task: AgentTask, plan: AgentPlan): Promise<ValidationResult> {
    const issues: ValidationIssue[] = [];

    // Check 1: Dependencies completed
    for (const depId of task.dependsOn) {
      const dep = plan.tasks.find(t => t.id === depId);
      if (!dep || dep.status !== 'done') {
        issues.push({
          type: 'dependency_incomplete',
          message: `Task ${depId} (${dep?.title}) must complete first`,
          autoFixable: false
        });
      }
    }

    // Check 2: Files to modify must exist
    for (const filePath of task.targetFiles) {
      const isNewFile = task.description.toLowerCase().includes('create') ||
                        task.description.toLowerCase().includes('new file');
      if (!isNewFile && !await fileExists(filePath)) {
        issues.push({
          type: 'file_missing',
          message: `Expected file not found: ${filePath}`,
          autoFixable: true,
          suggestedFix: `Adjust task to create ${filePath} first, or check path`
        });
      }
    }

    // Check 3: File not too large (protect context window)
    for (const filePath of task.targetFiles) {
      const size = await getFileSize(filePath);
      if (size > MAX_FILE_SIZE_BYTES) {
        issues.push({
          type: 'file_too_large',
          message: `${filePath} is ${(size/1024).toFixed(0)}KB — too large for context window`,
          autoFixable: false,
          suggestedFix: `Split task to only touch the relevant section of this file`
        });
      }
    }

    return {
      valid: issues.filter(i => !i.autoFixable).length === 0,
      issues
    };
  }
}

// In agentPipeline.ts — add before executeTask():
const validation = await validator.validate(task, plan);
if (!validation.valid) {
  const blockingIssues = validation.issues.filter(i => !i.autoFixable);
  throw new Error(`Pre-validation failed:\n${blockingIssues.map(i => i.message).join('\n')}`);
}
```

**Real-world example of what this catches:** Planner generates `src/controllers/user.ts`
but during execution the model writes to `src/controller/user.ts` (singular). Next task's
validator catches the path mismatch before a model call is wasted.

---

## Addition 4: Robust Output Parser with Retry [from v2 — KEPT INTACT]

Regex-only breaks constantly. Four fallback strategies with one retry pass.

```typescript
// outputParser.ts

export interface ParsedFileChange {
  path: string;
  content: string;
}

export interface ParseResult {
  changes: ParsedFileChange[];
  taskDoneSummary: string;
  parseStrategy: string; // for debugging: which strategy worked
}

export function parseModelOutput(raw: string): ParseResult | null {

  // Strategy 1: FILE: path + code fence (primary format we ask for)
  const result1 = tryPrimaryFormat(raw);
  if (result1?.changes.length > 0) return { ...result1, parseStrategy: 'primary' };

  // Strategy 2: Markdown headers — ## filename.ts
  const result2 = tryMarkdownHeaderFormat(raw);
  if (result2?.changes.length > 0) return { ...result2, parseStrategy: 'markdown_header' };

  // Strategy 3: Single code block — model returned one file without annotation
  const result3 = trySingleCodeBlock(raw);
  if (result3) return { ...result3, parseStrategy: 'single_block' };

  // Strategy 4: Unified diff format
  const result4 = tryDiffFormat(raw);
  if (result4?.changes.length > 0) return { ...result4, parseStrategy: 'diff' };

  return null;
}

function tryPrimaryFormat(raw: string): Omit<ParseResult, 'parseStrategy'> | null {
  const changes: ParsedFileChange[] = [];
  const pattern = /FILE:\s*(.+?)\s*\n```(?:\w+)?\n([\s\S]+?)\n```/g;
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    changes.push({ path: match[1].trim(), content: match[2] });
  }
  const summary = raw.match(/TASK_DONE:\s*(.+)/)?.[1]?.trim() ?? 'Completed';
  return changes.length > 0 ? { changes, taskDoneSummary: summary } : null;
}

function tryMarkdownHeaderFormat(raw: string): Omit<ParseResult, 'parseStrategy'> | null {
  const changes: ParsedFileChange[] = [];
  const pattern = /#{2,3}\s+(.+\.\w+)\s*\n```(?:\w+)?\n([\s\S]+?)\n```/g;
  let match;
  while ((match = pattern.exec(raw)) !== null) {
    changes.push({ path: match[1].trim(), content: match[2] });
  }
  return changes.length > 0 ? { changes, taskDoneSummary: 'Completed' } : null;
}

function trySingleCodeBlock(raw: string): Omit<ParseResult, 'parseStrategy'> | null {
  const match = raw.match(/```(?:\w+)?\n([\s\S]+?)\n```/);
  if (!match) return null;
  return {
    changes: [{ path: '__INFER_FROM_TASK__', content: match[1] }],
    taskDoneSummary: 'Completed'
  };
}

// Retry logic — ONE retry, ask model to reformat
export async function parseWithRetry(
  raw: string,
  task: AgentTask,
  model: IModelProvider
): Promise<ParseResult> {

  const result = parseModelOutput(raw);
  if (result) {
    if (result.changes[0]?.path === '__INFER_FROM_TASK__' && task.targetFiles.length === 1) {
      result.changes[0].path = task.targetFiles[0];
    }
    return result;
  }

  // Parse failed — ask model to reformat, ONE retry only
  const fixPrompt = `Your previous response could not be parsed.
Return ONLY the file content using this EXACT format:

FILE: <file path>
\`\`\`<language>
<complete file content>
\`\`\`
TASK_DONE: <one line summary>

Do not include any explanation.`;

  const retryResponse = await model.complete({
    system: 'You are a code output formatter. Return only properly formatted code.',
    user: fixPrompt,
    maxTokens: 4096
  });

  const retryResult = parseModelOutput(retryResponse);
  if (!retryResult) {
    throw new Error('Output parsing failed after retry. Task aborted.');
  }

  return retryResult;
}
```

---

## Addition 5: Streaming Log Output [from v2 — KEPT INTACT]

Token streaming to keep the UI alive. No live diff preview — just output text streaming.

```typescript
// Ollama provider — add onToken callback

async complete(options: {
  system: string;
  user: string;
  maxTokens?: number;
  onToken?: (token: string) => void;  // ADD THIS
}): Promise<string> {

  const response = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    body: JSON.stringify({
      model: this.modelName,  // comes from per-phase config (Addition 11)
      prompt: buildPrompt(options.system, options.user),
      stream: true
    })
  });

  const reader = response.body!.getReader();
  let full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = JSON.parse(new TextDecoder().decode(value));
    full += chunk.response;
    options.onToken?.(chunk.response);  // push token to UI
  }
  return full;
}
```

```tsx
// UI — streaming log panel below task list
const [logOutput, setLogOutput] = useState('');

await executeTask(task, (token) => {
  setLogOutput(prev => prev + token);
});

<div className="execution-log">
  <label>Model Output</label>
  <pre ref={autoScrollRef}>{logOutput}</pre>
</div>
```

---

## Addition 6: Diff Preview Before Applying [from v2 — KEPT INTACT]

Show before/after diff before writing to disk. User presses Apply or Skip.

```typescript
// diffPreview.ts

import * as diff from 'diff'; // ~25KB, likely already in node_modules

export interface FileDiff {
  path: string;
  isNew: boolean;
  hunks: string;
  lineAdded: number;
  lineRemoved: number;
}

export async function buildDiffPreview(
  changes: ParsedFileChange[]
): Promise<FileDiff[]> {
  const diffs: FileDiff[] = [];

  for (const change of changes) {
    const oldContent = await readFileOrEmpty(change.path);
    const isNew = oldContent === '';

    const unifiedDiff = diff.createPatch(
      change.path,
      oldContent,
      change.content,
      'before',
      'after'
    );

    const lines = unifiedDiff.split('\n');
    const added = lines.filter(l => l.startsWith('+')).length;
    const removed = lines.filter(l => l.startsWith('-')).length;

    diffs.push({ path: change.path, isNew, hunks: unifiedDiff, lineAdded: added, lineRemoved: removed });
  }

  return diffs;
}
```

```tsx
// DiffPreviewModal component
const DiffPreviewModal = ({ diffs, onApply, onSkip }) => (
  <div className="diff-modal">
    <h3>Review Changes Before Applying</h3>
    {diffs.map(d => (
      <div key={d.path} className="file-diff">
        <div className="diff-header">
          {d.isNew ? '🆕' : '✏️'} {d.path}
          <span className="stats">+{d.lineAdded} / -{d.lineRemoved}</span>
        </div>
        <pre className="diff-content">
          {d.hunks.split('\n').map((line, i) => (
            <span
              key={i}
              className={
                line.startsWith('+') ? 'diff-add' :
                line.startsWith('-') ? 'diff-remove' : 'diff-context'
              }
            >
              {line}
            </span>
          ))}
        </pre>
      </div>
    ))}
    <div className="diff-actions">
      <button onClick={onApply}>✅ Apply Changes</button>
      <button onClick={onSkip}>⏭ Skip This Task</button>
    </div>
  </div>
);
```

---

## Addition 7: Rollback Snapshots [from v2 — KEPT INTACT]

Before every file write, copy the file. On rollback, copy it back. ~40 lines.

```typescript
// rollbackManager.ts

export class RollbackManager {
  private snapshotDir: string; // .void/snapshots/

  async snapshot(taskId: string, filePaths: string[]): Promise<void> {
    const dir = path.join(this.snapshotDir, taskId);
    await fs.mkdir(dir, { recursive: true });

    for (const filePath of filePaths) {
      if (await fileExists(filePath)) {
        const snapPath = path.join(dir, filePath.replace(/\//g, '__'));
        await fs.copyFile(filePath, snapPath);
      }
    }
  }

  async rollback(taskId: string): Promise<string[]> {
    const dir = path.join(this.snapshotDir, taskId);
    if (!await fileExists(dir)) return [];

    const snapped = await fs.readdir(dir);
    const restored: string[] = [];

    for (const snap of snapped) {
      const originalPath = snap.replace(/__/g, '/');
      await fs.copyFile(path.join(dir, snap), originalPath);
      restored.push(originalPath);
    }

    return restored;
  }

  async cleanup(): Promise<void> {
    const dirs = await fs.readdir(this.snapshotDir);
    if (dirs.length <= 10) return;
    const oldest = dirs.sort().slice(0, dirs.length - 10);
    for (const dir of oldest) {
      await fs.rm(path.join(this.snapshotDir, dir), { recursive: true });
    }
  }
}
```

```tsx
// In task panel: rollback button per completed task
{task.status === 'done' && (
  <button className="rollback-btn" onClick={() => onRollback(task.id)}>
    ↩ Undo
  </button>
)}
```

---

## Addition 8: Config Controls [from v2 — KEPT INTACT, UPDATED FOR v3]

```typescript
// config.ts

export const AGENT_DEFAULTS = {
  // Model selection (new in v3 — see Addition 11)
  PLANNING_MODEL: 'qwen2.5-coder:7b',
  EXECUTION_MODEL: 'qwen2.5-coder:3b',

  // Token limits
  MAX_TOKENS_PLANNING: 2000,      // Planning phase sweet spot
  MAX_TOKENS_PER_TASK: 3000,      // Execution sweet spot
  MEMORY_CONTEXT_TOKENS: 800,     // Max tokens injected per model call

  // Task constraints
  MAX_FILE_SIZE_KB: 50,           // Files larger than this need manual splitting
  MAX_RETRIES_PER_TASK: 2,        // After 2 failures → re-plan
  MAX_TASKS_PER_PLAN: 10,         // Planner warned if it generates more
  MAX_FILES_PER_TASK: 3,          // Validator rejects tasks touching more than 3 files

  // Memory
  MEMORY_MAX_ENTRIES: 20,         // Memory cleanup threshold

  // UX
  REQUIRE_DIFF_APPROVAL: true,    // Show diff before applying (can be turned off)
  SHOW_PLAN_EDITOR: true,         // Show edit button on plan review panel (v3)
};
```

All exposed in VS Code settings so users can tune them without touching source code.

---

## Addition 9: Task Chunking in Planner [from v2 — KEPT INTACT]

No new system. Add to planner prompt + post-validation check.

```typescript
// Add to TASK_GENERATOR_SYSTEM prompt:
`
ADDITIONAL RULES:
- If a task description would exceed 400 characters, you MUST split it into 2+ tasks
- Each task must touch at most 3 files
- If a task requires creating AND modifying the same file, that is 2 separate tasks
- Label tasks as "create" vs "modify" vs "refactor" in the title
`

// Post-processing after plan generation:
function validatePlanTasks(tasks: AgentTask[]): AgentTask[] {
  return tasks.flatMap(task => {
    if (task.targetFiles.length > 3) {
      return splitTaskByFiles(task); // split into sub-tasks per file group
    }
    return [task];
  });
}
```

---

## Addition 10: Editable Plan & Task List [NEW in v3]

### The complete edit flow

```
Phase 1 completes → plan JSON in memory
       │
       ▼
Plan Review Panel shows:
  - Refined prompt (read-only display)
  - Numbered task list (read-only preview)
  - Buttons: [✏️ Edit Plan] [📋 Copy for AI] [✅ Approve & Execute]
       │
[✏️ Edit Plan] clicked
       │
       ▼
Plan Editor Panel opens (modal or side panel):
  Tab 1: "Edit Tasks"
    - Each task rendered as an expandable row
    - Editable fields: title, description, targetFiles (comma-separated input)
    - [+ Add Task] button at bottom
    - [✕] delete button per task
    - [↑↓] reorder arrows per task
  Tab 2: "Paste from AI"
    - Big textarea: "Paste your plan JSON here"
    - [Validate Plan] button → shows validation errors inline
    - [Use This Plan] button → replaces current plan
       │
[Save Changes] or [Use This Plan] clicked
       │
       ▼
planEditorService.savePlan(editedPlan):
  1. Run structural validation (see below)
  2. If valid → update agentPipeline.currentPlan
  3. If invalid → show errors, do NOT replace plan
       │
       ▼
Plan Review Panel refreshes showing updated plan
User clicks [✅ Approve & Execute]
```

### What the "Copy for AI" button sends to clipboard

This is the format that Gemini/ChatGPT understands best for plan refinement:

```typescript
// planExportImport.ts

export function formatPlanForExternalAI(plan: AgentPlan): string {
  return `
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
- taskType is one of: create, modify, refactor
`.trim();
}
```

### Paste-from-AI parser and validator

```typescript
// planExportImport.ts — continued

export interface PlanImportResult {
  success: boolean;
  tasks?: AgentTask[];
  errors?: string[];
}

export function importPlanFromAI(rawInput: string): PlanImportResult {
  // Step 1: Strip markdown fences if AI wrapped in ```json
  const cleaned = rawInput
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  // Step 2: Parse JSON
  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return { success: false, errors: [`Invalid JSON: ${e.message}`] };
  }

  // Step 3: Validate schema
  const errors: string[] = [];
  const tasks = parsed.tasks;

  if (!Array.isArray(tasks)) {
    return { success: false, errors: ['Expected { "tasks": [...] } at top level'] };
  }

  if (tasks.length === 0) {
    return { success: false, errors: ['Task list is empty'] };
  }

  if (tasks.length > 15) {
    errors.push(`Warning: ${tasks.length} tasks is a lot. Consider splitting into sessions.`);
    // Not a hard error — user may intentionally have a big plan
  }

  const validatedTasks: AgentTask[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const prefix = `Task ${i + 1}`;

    if (!t.id || typeof t.id !== 'string') {
      errors.push(`${prefix}: missing or invalid "id"`);
      continue;
    }
    if (seenIds.has(t.id)) {
      errors.push(`${prefix}: duplicate id "${t.id}"`);
      continue;
    }
    if (!t.title || typeof t.title !== 'string') {
      errors.push(`${prefix}: missing "title"`);
      continue;
    }
    if (!t.description || typeof t.description !== 'string') {
      errors.push(`${prefix}: missing "description"`);
      continue;
    }
    if (!Array.isArray(t.targetFiles) || t.targetFiles.length === 0) {
      errors.push(`${prefix}: "targetFiles" must be a non-empty array`);
      continue;
    }
    if (t.targetFiles.length > 3) {
      errors.push(`${prefix}: "${t.title}" touches ${t.targetFiles.length} files. Max is 3.`);
      // Soft error — warn but allow
    }

    // Check dependency IDs exist (check against already-seen IDs)
    const deps: string[] = t.dependsOn ?? [];
    for (const dep of deps) {
      if (!seenIds.has(dep)) {
        errors.push(`${prefix}: depends on "${dep}" which either doesn't exist or comes after this task`);
      }
    }

    seenIds.add(t.id);
    validatedTasks.push({
      id: t.id,
      title: t.title,
      description: t.description,
      targetFiles: t.targetFiles,
      dependsOn: deps,
      taskType: t.taskType ?? 'modify',
      status: 'pending'
    });
  }

  // Hard errors (missing id, title, files) block import
  const hardErrors = errors.filter(e => !e.startsWith('Warning:'));
  if (hardErrors.length > 0) {
    return { success: false, errors };
  }

  // Soft errors (warnings) allow import but display
  return { success: true, tasks: validatedTasks, errors };
}
```

### Plan Editor React component

```tsx
// planEditor.tsx — ~160 lines

interface PlanEditorProps {
  initialPlan: AgentPlan;
  onSave: (plan: AgentPlan) => void;
  onCancel: () => void;
}

const PlanEditor: React.FC<PlanEditorProps> = ({ initialPlan, onSave, onCancel }) => {
  const [tasks, setTasks] = useState(initialPlan.tasks);
  const [activeTab, setActiveTab] = useState<'edit' | 'paste'>('edit');
  const [pasteInput, setPasteInput] = useState('');
  const [pasteErrors, setPasteErrors] = useState<string[]>([]);
  const [pasteResult, setPasteResult] = useState<AgentTask[] | null>(null);

  // Inline task editing
  const updateTask = (idx: number, field: keyof AgentTask, value: any) => {
    setTasks(prev => prev.map((t, i) => i === idx ? { ...t, [field]: value } : t));
  };

  const deleteTask = (idx: number) => {
    setTasks(prev => prev.filter((_, i) => i !== idx));
  };

  const addTask = () => {
    const newTask: AgentTask = {
      id: `task_${Date.now()}`,
      title: 'New Task',
      description: '',
      targetFiles: [],
      dependsOn: [],
      taskType: 'modify',
      status: 'pending'
    };
    setTasks(prev => [...prev, newTask]);
  };

  const moveTask = (idx: number, direction: 'up' | 'down') => {
    const newTasks = [...tasks];
    const target = direction === 'up' ? idx - 1 : idx + 1;
    if (target < 0 || target >= newTasks.length) return;
    [newTasks[idx], newTasks[target]] = [newTasks[target], newTasks[idx]];
    setTasks(newTasks);
  };

  // Paste-from-AI handling
  const handleValidatePaste = () => {
    const result = importPlanFromAI(pasteInput);
    if (result.success && result.tasks) {
      setPasteResult(result.tasks);
      setPasteErrors(result.errors ?? []);
    } else {
      setPasteResult(null);
      setPasteErrors(result.errors ?? ['Unknown error']);
    }
  };

  const handleUsePastedPlan = () => {
    if (pasteResult) setTasks(pasteResult);
    setActiveTab('edit'); // Switch to edit tab to show the imported tasks
  };

  const handleSave = () => {
    onSave({ ...initialPlan, tasks });
  };

  return (
    <div className="plan-editor">
      <div className="plan-editor-tabs">
        <button
          className={activeTab === 'edit' ? 'active' : ''}
          onClick={() => setActiveTab('edit')}
        >
          ✏️ Edit Tasks
        </button>
        <button
          className={activeTab === 'paste' ? 'active' : ''}
          onClick={() => setActiveTab('paste')}
        >
          📋 Paste from AI
        </button>
      </div>

      {activeTab === 'edit' && (
        <div className="task-list-editor">
          {tasks.map((task, idx) => (
            <div key={task.id} className="task-row">
              <div className="task-row-controls">
                <button onClick={() => moveTask(idx, 'up')} disabled={idx === 0}>↑</button>
                <button onClick={() => moveTask(idx, 'down')} disabled={idx === tasks.length - 1}>↓</button>
                <button className="delete-task" onClick={() => deleteTask(idx)}>✕</button>
              </div>
              <div className="task-row-fields">
                <input
                  type="text"
                  value={task.title}
                  onChange={e => updateTask(idx, 'title', e.target.value)}
                  placeholder="Task title"
                />
                <textarea
                  value={task.description}
                  onChange={e => updateTask(idx, 'description', e.target.value)}
                  placeholder="What exactly should this task do?"
                  rows={2}
                />
                <input
                  type="text"
                  value={task.targetFiles.join(', ')}
                  onChange={e => updateTask(idx, 'targetFiles',
                    e.target.value.split(',').map(f => f.trim()).filter(Boolean)
                  )}
                  placeholder="src/file1.ts, src/file2.ts"
                />
              </div>
            </div>
          ))}
          <button className="add-task-btn" onClick={addTask}>+ Add Task</button>
        </div>
      )}

      {activeTab === 'paste' && (
        <div className="paste-from-ai">
          <p>Paste the improved plan JSON from Gemini or another AI:</p>
          <textarea
            value={pasteInput}
            onChange={e => setPasteInput(e.target.value)}
            rows={12}
            placeholder='{ "tasks": [ { "id": "task_001", ... } ] }'
          />
          <button onClick={handleValidatePaste}>Validate Plan</button>

          {pasteErrors.length > 0 && (
            <div className={`paste-errors ${pasteResult ? 'warnings' : 'errors'}`}>
              {pasteErrors.map((e, i) => <div key={i}>{e}</div>)}
            </div>
          )}

          {pasteResult && (
            <div className="paste-preview">
              <p>{pasteResult.length} tasks validated. Preview:</p>
              {pasteResult.map((t, i) => (
                <div key={t.id} className="paste-task-preview">
                  {i + 1}. {t.title} — {t.targetFiles.join(', ')}
                </div>
              ))}
              <button className="use-plan-btn" onClick={handleUsePastedPlan}>
                ✅ Use This Plan
              </button>
            </div>
          )}
        </div>
      )}

      <div className="plan-editor-footer">
        <button onClick={onCancel}>Cancel</button>
        <button className="save-plan-btn" onClick={handleSave}>
          Save Changes ({tasks.length} tasks)
        </button>
      </div>
    </div>
  );
};
```

### Making the model aware of the edited plan

This is the key question: after the user edits the plan, does Qwen know about it?

**Short answer: yes, automatically, with one small addition.**

The execution context for each task already includes task details from the plan object.
Since we update `agentPipeline.currentPlan` on save, Phase 2 reads the edited plan.

One thing to add: each task's execution prompt should include a "plan position" line
so Qwen understands what has been done and what comes next:

```typescript
// In agentPipeline.ts — build execution prompt for each task

function buildTaskExecutionPrompt(
  task: AgentTask,
  plan: AgentPlan, // this is the updated plan after user edits
  memory: string,
  fileContents: Record<string, string>
): string {

  const completedTasks = plan.tasks.filter(t => t.status === 'done');
  const upcomingTasks = plan.tasks
    .filter(t => t.status === 'pending' && t.id !== task.id)
    .slice(0, 3); // show next 3 tasks as lookahead

  return `
${memory}

PLAN CONTEXT:
Completed tasks: ${completedTasks.map(t => `[✓] ${t.title}`).join(' | ') || 'none yet'}
Upcoming tasks: ${upcomingTasks.map(t => `[ ] ${t.title}`).join(' | ') || 'this is the last task'}

CURRENT TASK: ${task.title}
DESCRIPTION: ${task.description}
TARGET FILES: ${task.targetFiles.join(', ')}

CURRENT FILE CONTENTS:
${Object.entries(fileContents).map(([f, c]) => `--- ${f} ---\n${c}`).join('\n\n')}

${EXECUTION_SYSTEM_PROMPT}
`;
}
```

The "completed / upcoming" lines are tiny (under 100 tokens) but give Qwen critical
context: "I already created auth.ts, now I need to wire it into routes.ts, and after
this I'll need to update the tests." This dramatically reduces errors from Qwen
not understanding the big picture.

---

## Addition 11: Per-Phase Model Selection [NEW in v3]

### Fetching available Ollama models

```typescript
// ollamaModelList.ts — ~20 lines

export async function getInstalledOllamaModels(): Promise<string[]> {
  try {
    const response = await fetch('http://localhost:11434/api/tags');
    if (!response.ok) return [];
    const data = await response.json();
    return data.models?.map((m: any) => m.name) ?? [];
  } catch {
    return []; // Ollama not running or not accessible
  }
}
```

### Config extension

```typescript
// config.ts — add to AGENT_DEFAULTS:
PLANNING_MODEL: 'qwen2.5-coder:7b',
EXECUTION_MODEL: 'qwen2.5-coder:3b',
```

### Model selector UI

```tsx
// agentPanel.tsx — add above the prompt input

const [availableModels, setAvailableModels] = useState<string[]>([]);
const [planningModel, setPlanningModel] = useState(AGENT_DEFAULTS.PLANNING_MODEL);
const [executionModel, setExecutionModel] = useState(AGENT_DEFAULTS.EXECUTION_MODEL);

useEffect(() => {
  getInstalledOllamaModels().then(setAvailableModels);
}, []);

// In JSX:
<div className="model-selectors">
  <label>
    Planning model
    <select
      value={planningModel}
      onChange={e => setPlanningModel(e.target.value)}
    >
      {availableModels.map(m => <option key={m} value={m}>{m}</option>)}
    </select>
  </label>
  <label>
    Execution model
    <select
      value={executionModel}
      onChange={e => setExecutionModel(e.target.value)}
    >
      {availableModels.map(m => <option key={m} value={m}>{m}</option>)}
    </select>
  </label>
</div>
```

### Passing model choice to pipeline

```typescript
// agentPipeline.ts — accept model names as config

export interface AgentPipelineConfig {
  planningModel: string;
  executionModel: string;
  // ...rest of config
}

// In runPlanningPhase():
const plannerModel = new OllamaProvider(config.planningModel);

// In runExecutionPhase():
const executorModel = new OllamaProvider(config.executionModel);
```

That is the complete implementation. One API call, two dropdowns, two config fields,
two OllamaProvider instantiations with different model names. ~50 lines total.

---

## What Was Rejected in v2 (Still Rejected in v3)

These are not revisited. Still wrong.

**❌ Confidence score (0.78) from local model:**
Small models output high confidence on wrong answers. This metric actively misleads.

**❌ Top-k relevance ranking for memory:**
Needs embedding model (more VRAM) or self-scoring (unreliable). Type-based filtering
gives 80% of the value at 0% cost.

**❌ Live file diff preview during streaming:**
VS Code's diffEditor takes time to init. Streaming into diff creates race conditions
and flicker. Show streaming log, show diff after completion. Value not worth complexity.

**❌ Separate workspace fingerprint system:**
`buildWorkspaceContext()` already does this. Enhance that function. No new class.

---

## Updated Implementation Sequence (v3)

v2 was 23 hours. v3 adds 4.5 hours for the two new features.

| Step | What | Complexity | Time |
|---|---|---|---|
| Step 0 | Set up Ollama models (7b + 3b), test JSON output from each | Setup | 30 min |
| Step 1 | Types + interfaces (updated with `taskType`, `status`, plan schema) | Low | 2 hr |
| Step 2 | `memoryStore.ts` — type tags, buildContextString(), local disk persistence | Medium | 2 hr |
| Step 3 | `taskValidator.ts` — file checks + dependency checks | Low | 1 hr |
| Step 4 | `rollbackManager.ts` — snapshot before write | Low | 1 hr |
| Step 5 | `outputParser.ts` — multi-strategy parser + retry | Medium | 2 hr |
| Step 6 | Add `onToken` streaming to Ollama provider | Low | 1 hr |
| Step 7 | Planning phase — prompt refinement + task list + chunking check | Medium | 3 hr |
| Step 8 | Execution phase + re-planning loop | High | 3 hr |
| Step 9 | `diffPreview.ts` + DiffPreviewModal UI | Medium | 2 hr |
| Step 10 | Task list panel + streaming log panel | Medium | 3 hr |
| Step 11 | Settings + config constants | Low | 1 hr |
| Step 12 | `planExportImport.ts` — Copy for AI + importPlanFromAI() | Low | 1.5 hr |
| Step 13 | `planEditor.tsx` — Edit Tasks tab + Paste from AI tab | Medium | 2 hr |
| Step 14 | `ollamaModelList.ts` + model selector UI + pass to pipeline | Low | 1 hr |
| Step 15 | End-to-end test + prompt tuning | Testing | 2 hr |

**Total: ~27.5 hours.** 4.5 hours more than v2 for two genuinely useful additions.

---

## File Map — Everything You Need to Create or Modify

### New files (create from scratch)

```
src/
  agent/
    memoryStore.ts          ← Addition 2: typed memory + disk persistence
    taskValidator.ts        ← Addition 3: pre-execution validation
    rollbackManager.ts      ← Addition 7: file snapshots
    outputParser.ts         ← Addition 4: multi-strategy parser + retry
    diffPreview.ts          ← Addition 6: unified diff builder
    agentPipeline.ts        ← Core orchestrator (new, replaces existing basic agent)
    planExportImport.ts     ← Addition 10: Copy for AI + Paste from AI
    ollamaModelList.ts      ← Addition 11: fetch installed Ollama models
    config.ts               ← Addition 8: all AGENT_DEFAULTS
    promptTemplates.ts      ← All system prompts in one place
  ui/
    taskListPanel.tsx        ← Task list with status + rollback buttons
    streamingLogPanel.tsx    ← Token streaming display
    diffPreviewModal.tsx     ← Diff approval UI
    planReviewPanel.tsx      ← Phase 1 output review + approve
    planEditor.tsx           ← Addition 10: inline edit + paste from AI tabs
    modelSelectorBar.tsx     ← Addition 11: planning + execution dropdowns
```

### Files to modify (already exist in Void)

```
src/
  vs/workbench/contrib/void/
    ollamaProvider.ts       ← Add onToken streaming callback
    agentSettings.ts        ← Add new config fields
    agentPanel.tsx          ← Wire in new UI panels + model selector
```

---

## Honest Final State After All This

```
Strong zone (will work 70-80% of the time with this setup):
  ✅ CRUD APIs (Express, FastAPI, etc.)
  ✅ React/Vue components with clear specs
  ✅ Adding features to existing files (if file < 50KB)
  ✅ Writing unit tests for existing code
  ✅ Config changes, environment setup
  ✅ Simple DB model + migration
  ✅ Any task where the AI-generated plan was replaced with a Gemini-refined plan

Weak zone (will need manual intervention sometimes):
  ⚠️ Large refactors (>8 tasks) — Qwen loses track
  ⚠️ Complex logic bugs — model might misdiagnose
  ⚠️ Files >50KB — breaks context window
  ⚠️ 3+ layers of abstraction changes at once
  ⚠️ Tasks where the 3b execution model disagrees with the 7b plan

Will not work, be honest about it:
  ❌ Unknown legacy codebase with no prior memory
  ❌ Performance optimization requiring profiling
  ❌ Security audit / finding vulnerabilities
  ❌ Anything requiring knowledge of the whole codebase at once
```

### What 60-70% agentic experience looks like in practice

With this plan fully implemented on a 7b/3b Ollama setup, you get:

- A prompt goes in → refined prompt + task list comes out in ~20-30 seconds (planning phase)
- You can edit that plan manually or paste a better one from Gemini
- Each task executes with a streaming log so you see what's happening
- Diffs show before any file is touched
- Memory carries forward what was built
- Failures re-plan automatically

What you won't get (and no local-only setup gives you this):
- The plan correctly handles a large existing codebase it's never seen
- The model correctly diagnoses a subtle bug from error logs alone
- Tasks completing without any user review (risky anyway)

The 60-70% target is honest and achievable. For common day-to-day feature work
on a codebase the agent has context on, this is a genuinely useful tool.
