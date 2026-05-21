# TaskLite

TaskLite is a lightweight, tree-aware Obsidian task plugin inspired by Tasks.

It focuses on editing and rendering regular Markdown task lines, not on the Tasks query language.

## Features

- Tasks-compatible emoji metadata for due dates, scheduled dates, done dates, cancelled dates, recurrence, ids, and dependencies.
- Tree-aware toggling based on Obsidian list item metadata.
- Recurring parent tasks can copy their descendant subtasks into the next occurrence.
- Automatic done and cancelled dates.
- Reading View rendering with stable `taskslite-*` classes and `data-task-*` attributes.
- Live Preview checkbox interception for TaskLite toggling.
- `@` emoji input suggestions on task lines.
- Best-effort import of custom status settings from the Tasks plugin.
- Tasks API v1 toggle compatibility for plugins that complete recurring tasks through Tasks.

## Usage

Run the `Toggle task` command on a task line, or click a task checkbox in Reading View or Live Preview.

For emoji suggestions, type `@` on a Markdown task line and select a field.

Supported recurrence rules in this MVP:

- `every day`
- `every week`
- `every month`
- `every year`
- `every N days`
- `every N weeks`
- `every N months`
- `every N years`

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

## Release

The repository includes `.github/workflows/release.yml` for automatic GitHub releases.

The workflow runs when you push a tag that matches `x.y.z`, builds the plugin, creates a GitHub release, and uploads:

- `manifest.json`
- `main.js`
- `styles.css`

Recommended release flow:

1. Update your code and commit it.
2. Bump the version with `npm version patch`, `npm version minor`, or `npm version major`.
3. Push the branch and tag with `git push --follow-tags`.

Notes:

- The tag must exactly match `manifest.json`'s version, with no leading `v`.
- `version-bump.mjs` keeps `manifest.json` and `versions.json` in sync during `npm version`.
- GitHub Actions needs the default workflow permissions to allow `contents: write` for releases.

## Scope

TaskLite v1 intentionally does not implement Tasks query code blocks, modal editing, full recurrence grammar, or dependency semantics. Copied recurring subtasks clear ids, dependencies, block links, done dates, and cancelled dates to avoid unsafe duplicate references.
