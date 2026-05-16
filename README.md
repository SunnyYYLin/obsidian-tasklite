# TasksLite

TasksLite is a lightweight, tree-aware Obsidian task plugin inspired by Tasks.

It focuses on editing and rendering regular Markdown task lines, not on the Tasks query language.

## Features

- Tasks-compatible emoji metadata such as `📅`, `⏳`, `✅`, `❌`, `🔁`, `🆔`, and `⛔`.
- Tree-aware toggling based on Obsidian list item metadata.
- Recurring parent tasks can copy their descendant subtasks into the next occurrence.
- Automatic done and cancelled dates.
- Reading View rendering with stable `taskslite-*` classes and `data-task-*` attributes.
- Live Preview checkbox interception for TasksLite toggling.
- `@` emoji input suggestions on task lines.
- Best-effort import of custom status settings from the Tasks plugin.

## Usage

Run the command **Toggle TasksLite task / 切换 TasksLite 任务** on a task line, or click a task checkbox in Reading View or Live Preview.

For emoji suggestions, type `@` on a Markdown task line and select a field.

Supported recurrence rules in this MVP:

- `🔁 every day`
- `🔁 every week`
- `🔁 every month`
- `🔁 every year`
- `🔁 every N days/weeks/months/years`

## Development

This project keeps the standard npm scripts, but Bun is also supported for faster local feedback.

```bash
bun install
bun test
bun run build
```

The npm path still works:

```bash
npm install
npm run build
```

## Scope

TasksLite v1 intentionally does not implement Tasks query code blocks, modal editing, full recurrence grammar, or dependency semantics. Copied recurring subtasks clear ids, dependencies, block links, done dates, and cancelled dates to avoid unsafe duplicate references.
