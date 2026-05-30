# TaskLite

TaskLite is a lightweight, tree-aware Obsidian task plugin compatible with the Tasks plugin's emoji metadata format. It focuses on editing and rendering standard Markdown task lines.

## Features

- Tasks-compatible emoji metadata (dates, recurrence, priority, assignee, etc.)
- Tree-aware toggling: finish/unfinish cascades to children and bubbles to parent
- Recurring tasks with automatic next occurrence creation
- Automatic done/cancelled dates
- Live Preview checkbox interception
- `@` emoji input suggestions on task lines
- Best-effort import of custom status settings from the Tasks plugin
- External task reconciliation (detects checkbox changes from other plugins)
- `tasks: ignore` frontmatter to exclude files from scanning

## Task Line Format

```markdown
- [ ] Task description ⏳ 2026-01-01 📅 2026-01-15 🔁 every week 👤 Mary
```

### Supported Emoji Fields

| Emoji | Field | Example |
|-------|-------|---------|
| 🔺 | Priority: highest | `🔺` |
| ⏫ | Priority: high | `⏫` |
| 🔼 | Priority: medium | `🔼` |
| 🔽 | Priority: low | `🔽` |
| ⏬ | Priority: lowest | `⏬` |
| 🛫 | Start date | `🛫 2026-01-01` |
| ➕ | Created date | `➕ 2026-01-01` |
| ⏳ | Scheduled date | `⏳ 2026-01-01` |
| 📅 | Due date | `📅 2026-01-15` |
| ✅ | Done date | `✅ 2026-01-10` |
| ❌ | Cancelled date | `❌ 2026-01-10` |
| 🔁 | Recurrence | `🔁 every week` |
| 🏁 | On completion | `🏁 delete` |
| ⛔ | Depends on | `⛔ task-id` |
| 🆔 | Task ID | `🆔 my-task` |
| 👤 | Assignee | `👤 Mary` |

### Supported Recurrence Rules

- `every day`, `every week`, `every month`, `every year`
- `every N days`, `every N weeks`, `every N months`, `every N years`
- `every weekday`
- `every week on Monday`, `every week on Friday`
- `every month on the 1st`
- `every day when done` (recurrence relative to completion date)

### Ignoring Files

Add `tasks: ignore` to a file's YAML frontmatter to exclude it from TaskLite scanning:

```yaml
---
tasks: ignore
---
```

## API

TaskLite exposes a JavaScript API via `app.plugins.plugins.taskslite.api` for other plugins to use.

### Accessing the API

```js
const api = app.plugins.plugins.taskslite.api;
```

### `listTasks(options?)`

Returns all tasks in the vault.

```js
const tasks = await api.listTasks({
  includeCompleted: false,  // default: false
  includeCancelled: false,  // default: false
  includeChildren: false,   // default: false
});
```

**Parameters:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `includeCompleted` | `boolean` | `false` | Include tasks with `DONE` status |
| `includeCancelled` | `boolean` | `false` | Include tasks with `CANCELLED` status |
| `includeChildren` | `boolean` | `false` | Include subtasks (non-root tasks) |

**Returns:** `Promise<TaskLiteTaskRecord[]>`

Each `TaskLiteTaskRecord` contains:

| Field | Type | Description |
|-------|------|-------------|
| `path` | `string` | Vault-relative file path |
| `basename` | `string` | File name without extension |
| `lineNumber` | `number` | 0-based line number in the file |
| `parentLine` | `number \| null` | Line number of the parent task, or `null` for root tasks |
| `depth` | `number` | Nesting depth (0 for root tasks) |
| `hasChildren` | `boolean` | Whether this task has child tasks |
| `task` | `TaskLine` | Parsed task data (see below) |

**`TaskLine` structure:**

| Field | Type | Description |
|-------|------|-------------|
| `indentation` | `string` | Leading whitespace |
| `listMarker` | `string` | List marker (`-`, `*`, `+`, or `1.`) |
| `status` | `StatusConfiguration` | Status object with `symbol`, `type`, `name` |
| `metadata` | `TaskMetadata` | Parsed metadata (see below) |
| `original` | `string` | Original line text |

**`TaskMetadata` structure:**

| Field | Type | Description |
|-------|------|-------------|
| `description` | `string` | Task text without metadata |
| `priority` | `string \| null` | Priority emoji (`🔺`, `⏫`, `🔼`, `🔽`, `⏬`) |
| `dates.start` | `string \| null` | Start date (`YYYY-MM-DD`) |
| `dates.created` | `string \| null` | Created date |
| `dates.scheduled` | `string \| null` | Scheduled date |
| `dates.due` | `string \| null` | Due date |
| `dates.done` | `string \| null` | Done date |
| `dates.cancelled` | `string \| null` | Cancelled date |
| `recurrence` | `string \| null` | Recurrence rule text |
| `onCompletion` | `string \| null` | On-completion action |
| `dependsOn` | `string \| null` | Dependency IDs |
| `id` | `string \| null` | Task ID |
| `person` | `string \| null` | Assignee name |
| `blockLink` | `string \| null` | Obsidian block link (`^abc123`) |
| `tags` | `string[]` | Hashtags found in description |

**Example:**

```js
const api = app.plugins.plugins.taskslite.api;

// Get all incomplete root tasks
const tasks = await api.listTasks();

// Get all tasks including completed ones and subtasks
const all = await api.listTasks({
  includeCompleted: true,
  includeCancelled: true,
  includeChildren: true,
});

// Filter by assignee
const maryTasks = tasks.filter(t => t.task.metadata.person === "Mary");

// Filter by due date
const today = window.moment().format("YYYY-MM-DD");
const dueToday = tasks.filter(t => t.task.metadata.due === today);
```

### `finishTask(path, lineNumber)`

Marks a task as done. Cascades to children if enabled in settings.

```js
const success = await api.finishTask("Tasks/My_Tasks.md", 5);
```

**Returns:** `Promise<boolean>` — `true` if the task was found and updated.

### `unfinishTask(path, lineNumber)`

Marks a done/cancelled task as todo. Un-cascades from children if enabled.

```js
const success = await api.unfinishTask("Tasks/My_Tasks.md", 5);
```

**Returns:** `Promise<boolean>`

### `cancelTask(path, lineNumber)`

Marks a task as cancelled.

```js
const success = await api.cancelTask("Tasks/My_Tasks.md", 5);
```

**Returns:** `Promise<boolean>`

### `uncancelTask(path, lineNumber)`

Restores a cancelled task to todo.

```js
const success = await api.uncancelTask("Tasks/My_Tasks.md", 5);
```

**Returns:** `Promise<boolean>`

### `createTask(line, options?)`

Creates a new task in a file.

```js
// Append to default inbox (Tasks/New_Tasks.md)
await api.createTask("- [ ] New task 📅 2026-06-01");

// Specify target file
await api.createTask("- [ ] New task", { path: "Tasks/My_Tasks.md" });

// Insert as child of a specific line
await api.createTask("- [ ] Subtask", {
  path: "Tasks/My_Tasks.md",
  parentLineNumber: 5,  // 0-based line number of the parent task
});
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `line` | `string` | Full task line (including `- [ ]` prefix) |
| `options.path` | `string` | Target file path (default: `Tasks/New_Tasks.md`) |
| `options.parentLineNumber` | `number` | 0-based line number to insert after (as a child with indentation) |

### `executeTasksToggleCommand(line, path)`

Toggles a task line (compatible with Tasks plugin's `executeToggleTaskDoneCommand`). If the file is open in an editor, uses the editor context; otherwise toggles the single line.

```js
const updatedLine = api.executeTasksToggleCommand(
  "- [ ] My task",
  "Tasks/My_Tasks.md"
);
// Returns: "- [x] My task ✅ 2026-05-31"
```

**Returns:** `string` — The toggled task line.

## Commands

| Command | ID | Description |
|---------|----|-------------|
| Toggle task | `toggle-task` | Cycle through task states (todo → done → todo) |
| Toggle task cancellation | `toggle-task-cancellation` | Cycle through cancellation states |
| Cancel task | `cancel-task` | Mark task as cancelled |
| Uncancel task | `uncancel-task` | Restore cancelled task |
| Import status settings | `import-tasks-status-settings` | Import from Tasks plugin |

## Development

```bash
bun install          # Install dependencies
bun test             # Run tests
bun run build        # Production build (tsc + esbuild)
bun run dev          # Development mode (watch)
bun run lint         # ESLint check
```

## Release

Push a tag matching `x.y.z` to trigger automatic GitHub release:

```bash
npm version patch    # Bumps version in manifest.json and versions.json
git push && git push --tags
```

## License

MIT
