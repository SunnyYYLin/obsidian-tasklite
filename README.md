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

## Creating Tasks & Task Syntax

A task in TaskLite is a standard Markdown checklist item (e.g., `- [ ]`) followed by a description and metadata emojis.

### Task Emojis & Fields

Append these emojis to your task description to add metadata:

* 📅 **Due Date**: `📅 YYYY-MM-DD` (e.g., `📅 2026-06-30`)
* ⏳ **Scheduled Date**: `⏳ YYYY-MM-DD` (e.g., `⏳ 2026-06-25`)
* 🛫 **Start Date**: `🛫 YYYY-MM-DD` (e.g., `🛫 2026-06-20`)
* ➕ **Created Date**: `➕ YYYY-MM-DD` (automatically added upon creation)
* 🔁 **Recurrence**: `🔁 <rule>` (e.g., `🔁 every week`, `🔁 every weekday`, `🔁 every 2 days`)
* 👤 **Assignee**: `👤 <name>` or `👤 <name1> & <name2>` (e.g., `👤 Mary`, `👤 Alice & Bob`)
* 🏁 **On Completion**: `🏁 delete` or `🏁 keep` (controls whether a recurring task is deleted/kept on completion)
* 🆔 **Task ID**: `🆔 <id>` (for task dependency identification)
* ⛔ **Depends On**: `⛔ <id>` (specifies parent/dependent tasks)
* **Priority**: Add one of the following priority emojis at the end of the task line:
  * Highest: `🔺`
  * High: `⏫`
  * Medium: `🔼`
  * Low: `🔽`
  * Lowest: `⏬`

### Indentation and Subtasks (Tree Structure)

TaskLite is tree-aware. Simply indent your list items using tabs or spaces to create subtasks:

```markdown
- [ ] Parent task
    - [ ] Subtask 1 (completes automatically when Parent task is finished)
    - [ ] Subtask 2
```

### Quick Input with Emoji Auto-Suggest

When typing a task line, type `@` to open the emoji auto-suggest menu, allowing you to quickly insert date placeholders, priority symbols, assignees, or recurring rules.

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
