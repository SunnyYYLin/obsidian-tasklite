import type { CachedMetadata, TFile } from "obsidian";
import type { StatusRegistry, StatusType } from "./status";
import type { TaskPriority, OnCompletionAction } from "./format";

/**
 * A task encoded entirely in a file's YAML frontmatter rather than as a
 * Markdown list item.  The file itself is the task; there is no line number.
 *
 * To enable, add `task: true` (or any truthy value) to the frontmatter:
 *
 * ```yaml
 * ---
 * task: true
 * status: " "
 * description: "Project Alpha"
 * due: "2026-06-30"
 * priority: "⏫"
 * ---
 * ```
 *
 * Supported frontmatter keys: task, status, description, due, scheduled,
 * start, created, done, cancelled, priority, recurrence, onCompletion, id,
 * dependsOn, person.
 */
export interface FrontmatterTaskRecord {
	/** Vault-relative path of the file, e.g. "Projects/Alpha.md". */
	path: string;
	/** File basename without extension, e.g. "Alpha". */
	basename: string;
	/** Always -1 – sentinel value indicating this is a file-level task. */
	lineNumber: -1;
	/** Always null – file-level tasks have no parent. */
	parentLine: null;
	/** Always 0 – file-level tasks are top-level by definition. */
	depth: 0;
	/** Whether the file contains child list-item tasks in its body. */
	hasChildren: boolean;
	/** Parsed task data built from frontmatter fields. */
	task: FrontmatterTaskData;
}

export interface FrontmatterTaskData {
	statusSymbol: string;
	statusType: StatusType;
	description: string;
	priority: TaskPriority | null;
	dates: {
		start: string | null;
		created: string | null;
		scheduled: string | null;
		due: string | null;
		done: string | null;
		cancelled: string | null;
	};
	recurrence: string | null;
	onCompletion: OnCompletionAction | null;
	id: string | null;
	dependsOn: string | null;
	person: string | null;
}

const PRIORITY_SYMBOLS = new Set(["🔺", "⏫", "🔼", "🔽", "⏬"]);

/**
 * Try to parse a file's frontmatter as a task record.
 * Returns `null` when the frontmatter does not contain `task: true` (or any
 * truthy value), or when the file should be ignored (`tasks: ignore`).
 */
export function parseFrontmatterTask(
	file: TFile,
	metadata: CachedMetadata | null | undefined,
	registry: StatusRegistry,
	hasChildren: boolean,
): FrontmatterTaskRecord | null {
	const fm = metadata?.frontmatter;
	if (!fm || !fm["task"]) return null;
	if (fm["tasks"] === "ignore") return null;

	const statusSymbol = typeof fm["status"] === "string" ? fm["status"] : " ";
	const statusConfig = registry.get(statusSymbol);

	const rawPriority = fm["priority"];
	const priority: TaskPriority | null =
		typeof rawPriority === "string" && PRIORITY_SYMBOLS.has(rawPriority)
			? (rawPriority as TaskPriority)
			: null;

	const rawOnCompletion = fm["onCompletion"] ?? fm["on_completion"];
	const onCompletion: OnCompletionAction | null =
		rawOnCompletion === "delete" || rawOnCompletion === "keep"
			? rawOnCompletion
			: null;

	const task: FrontmatterTaskData = {
		statusSymbol: statusConfig.symbol,
		statusType: statusConfig.type,
		description: typeof fm["description"] === "string" ? fm["description"] : file.basename,
		priority,
		dates: {
			start: dateField(fm["start"]),
			created: dateField(fm["created"]),
			scheduled: dateField(fm["scheduled"]),
			due: dateField(fm["due"]),
			done: dateField(fm["done"]),
			cancelled: dateField(fm["cancelled"]),
		},
		recurrence: typeof fm["recurrence"] === "string" ? fm["recurrence"] : null,
		onCompletion,
		id: typeof fm["id"] === "string" ? fm["id"] : null,
		dependsOn: typeof fm["dependsOn"] === "string" ? fm["dependsOn"] : null,
		person: typeof fm["person"] === "string" ? fm["person"] : null,
	};

	return {
		path: file.path,
		basename: file.basename,
		lineNumber: -1,
		parentLine: null,
		depth: 0,
		hasChildren,
		task,
	};
}

/**
 * Build a minimal frontmatter patch object to update the task's status and
 * optional date fields.  Returns an object suitable for merging into existing
 * frontmatter.
 */
export function buildFrontmatterPatch(
	current: FrontmatterTaskData,
	updates: Partial<FrontmatterTaskData>,
): Record<string, unknown> {
	const patch: Record<string, unknown> = {};

	if (updates.statusSymbol !== undefined) patch["status"] = updates.statusSymbol;
	if (updates.priority !== undefined) patch["priority"] = updates.priority;
	if (updates.description !== undefined) patch["description"] = updates.description;
	if (updates.recurrence !== undefined) patch["recurrence"] = updates.recurrence;
	if (updates.onCompletion !== undefined) patch["onCompletion"] = updates.onCompletion;
	if (updates.id !== undefined) patch["id"] = updates.id;
	if (updates.dependsOn !== undefined) patch["dependsOn"] = updates.dependsOn;
	if (updates.person !== undefined) patch["person"] = updates.person;

	if (updates.dates) {
		const d = updates.dates;
		if (d.start !== undefined) patch["start"] = d.start ?? null;
		if (d.created !== undefined) patch["created"] = d.created ?? null;
		if (d.scheduled !== undefined) patch["scheduled"] = d.scheduled ?? null;
		if (d.due !== undefined) patch["due"] = d.due ?? null;
		if (d.done !== undefined) patch["done"] = d.done ?? null;
		if (d.cancelled !== undefined) patch["cancelled"] = d.cancelled ?? null;
	}

	// Carry over fields that are not being updated
	if (!("status" in patch)) patch["status"] = current.statusSymbol;

	return patch;
}

/**
 * Apply a key→value patch to the raw YAML frontmatter block of a file's
 * content string, returning the updated content.
 *
 * Only existing frontmatter keys are updated; new keys are appended.
 * `null` values remove the key.
 */
export function applyFrontmatterPatchToContent(
	content: string,
	patch: Record<string, unknown>,
): string {
	const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/u);
	if (!fmMatch) return content;

	const fmBlock = fmMatch[1] ?? "";
	const afterFm = content.slice(fmMatch[0].length);
	const lines = fmBlock.split(/\r?\n/u);

	const updated = new Map<string, string>();
	for (const [key, value] of Object.entries(patch)) {
		updated.set(key, value === null ? "" : String(value));
	}

	const resultLines: string[] = [];
	const handled = new Set<string>();

	for (const line of lines) {
		const keyMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)/u);
		if (keyMatch) {
			const key = keyMatch[1] ?? "";
			if (updated.has(key)) {
				handled.add(key);
				const newVal = updated.get(key) ?? "";
				if (newVal !== "") {
					resultLines.push(`${key}: ${newVal}`);
				}
				// null → omit the line entirely
				continue;
			}
		}
		resultLines.push(line);
	}

	// Append new keys that were not already in the frontmatter
	for (const [key, value] of updated) {
		if (!handled.has(key) && value !== "") {
			resultLines.push(`${key}: ${value}`);
		}
	}

	const newFm = `---\n${resultLines.join("\n")}\n---\n`;
	return newFm + afterFm;
}

function dateField(value: unknown): string | null {
	if (typeof value !== "string") return null;
	return /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : null;
}
