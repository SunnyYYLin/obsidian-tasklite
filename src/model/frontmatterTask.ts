import type { CachedMetadata, FileManager, TFile } from "obsidian";
import type { StatusRegistry } from "./status";
import type { TaskPriority, OnCompletionAction, TaskData } from "./format";
import { normalizeTaskDateValue, resolveDueDateFromStart, timeOnlyRegex } from "./format";
import { normalizeAssignees } from "./assignee";

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
 * dependsOn, person, remind.
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
	/** Always -1 – file-level tasks have depth -1. */
	depth: -1;
	/** Whether the file contains child list-item tasks in its body. */
	hasChildren: boolean;
	/** Parsed task data built from frontmatter fields. */
	task: TaskData;
	/** Raw status value from frontmatter before mapping. */
	rawStatus: string | null;
}

const PRIORITY_MAP: Record<string, TaskPriority> = {
	"🔺": "highest",
	highest: "highest",
	"⏫": "high",
	high: "high",
	"🔼": "medium",
	medium: "medium",
	"🔽": "low",
	low: "low",
	"⏬": "lowest",
	lowest: "lowest",
};

const STATUS_KEYWORD_MAP: Record<string, string> = {
	todo: " ",
	open: " ",
	done: "x",
	complete: "x",
	completed: "x",
	"in-progress": "/",
	inprogress: "/",
	doing: "/",
	active: "/",
	cancelled: "-",
	canceled: "-",
};

function resolveStatusSymbol(
	rawStatus: unknown,
	registry: StatusRegistry,
): string {
	if (typeof rawStatus !== "string") {
		return " ";
	}

	const normalized = rawStatus.trim().toLowerCase();

	// 1. Direct symbol check in registry
	if (registry.has(rawStatus)) {
		return rawStatus;
	}
	if (registry.has(normalized)) {
		return normalized;
	}

	// 2. Keyword map check
	if (normalized in STATUS_KEYWORD_MAP) {
		return STATUS_KEYWORD_MAP[normalized] ?? " ";
	}

	// 3. Scan registry for name or type match
	for (const config of registry.getAll()) {
		if (config.name.toLowerCase() === normalized) {
			return config.symbol;
		}
		if (config.type.toLowerCase() === normalized) {
			return config.symbol;
		}
		if (config.type.toLowerCase().replace("_", "-") === normalized) {
			return config.symbol;
		}
	}

	return " ";
}

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
	content?: string,
): FrontmatterTaskRecord | null {
	const fm = metadata?.frontmatter;
	if (!fm || !fm["task"]) return null;
	if (fm["tasks"] === "ignore") return null;

	const fmRecord = fm as Record<string, unknown>;
	const rawStatus = typeof fmRecord["status"] === "string" ? fmRecord["status"] : null;
	const statusSymbol = resolveStatusSymbol(fmRecord["status"], registry);
	const statusConfig = registry.get(statusSymbol);

	const rawPriority = fmRecord["priority"];
	const priority: TaskPriority | null =
		typeof rawPriority === "string" && rawPriority in PRIORITY_MAP
			? (PRIORITY_MAP[rawPriority] ?? null)
			: null;

	const rawOnCompletion = fmRecord["onCompletion"] ?? fmRecord["on_completion"];
	const onCompletion: OnCompletionAction | null =
		rawOnCompletion === "delete" || rawOnCompletion === "keep"
			? rawOnCompletion
			: null;

	const rawAssignee: unknown = parseFrontmatterAssigneeFromContent(content) ??
		fmRecord["assignee"] ??
		fmRecord["person"];
	let assignee: string[] = [];
	if (Array.isArray(rawAssignee)) {
		assignee = rawAssignee
			.map(String)
			.map((p) => p.trim())
			.filter(Boolean);
	} else if (typeof rawAssignee === "string") {
		assignee = rawAssignee
			.split("&")
			.map((p) => p.trim())
			.filter(Boolean);
	}

	assignee = normalizeAssignees(assignee);

	const task: TaskData = {
		status: statusConfig.type,
		description:
			typeof fm["description"] === "string"
				? fm["description"]
				: file.basename,
		priority,
		dates: {
			start: dateField(fm["start"]),
			created: dateField(fm["created"]),
			scheduled: dateField(fm["scheduled"]),
			due:
				resolveDueDateFromStart(
					dateField(fm["due"]),
					dateField(fm["start"]),
				) ?? dateField(fm["due"]),
			done: dateField(fm["done"]),
			cancelled: dateField(fm["cancelled"]),
			remind: dateField(fm["remind"]),
		},
		recurrence:
			typeof fm["recurrence"] === "string" ? fm["recurrence"] : null,
		onCompletion,
		id: typeof fm["id"] === "string" ? fm["id"] : null,
		dependsOn: typeof fm["dependsOn"] === "string" ? fm["dependsOn"] : null,
		assignee,
		location: typeof fm["location"] === "string" ? fm["location"] : null,
		blockLink: null,
		tags: Array.isArray(fm["tags"]) ? fm["tags"].map(String) : [],
		unmatched: null,
	};

	return {
		path: file.path,
		basename: file.basename,
		lineNumber: -1,
		parentLine: null,
		depth: -1,
		hasChildren,
		task,
		rawStatus,
	};
}

/**
 * Build a minimal frontmatter patch object to update the task's status and
 * optional date fields.  Returns an object suitable for merging into existing
 * frontmatter.
 */
function parseFrontmatterAssigneeFromContent(content: string | undefined): string[] | null {
	if (!content) return null;
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
	if (!match) return null;

	const lines = (match[1] ?? "").split(/\r?\n/u);
	for (let i = 0; i < lines.length; i++) {
		const keyMatch = lines[i]?.match(/^assignee:\s*(.*)$/u);
		if (!keyMatch) continue;

		const inlineValue = (keyMatch[1] ?? "").trim();
		const listValues: string[] = [];
		for (let j = i + 1; j < lines.length; j++) {
			const line = lines[j] ?? "";
			if (/^[^\s].*:/u.test(line)) break;
			const itemMatch = line.match(/^\s+-\s+(.+)$/u);
			if (itemMatch) {
				listValues.push((itemMatch[1] ?? "").trim());
			}
		}

		if (inlineValue.length > 0) {
			return inlineValue.split("&").map((p) => p.trim()).filter(Boolean);
		}
		return listValues;
	}

	return null;
}

export function buildFrontmatterPatch(
	current: TaskData,
	updates: Partial<TaskData>,
	registry: StatusRegistry,
	currentStatusRaw?: string | null,
): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	const useKeyword =
		typeof currentStatusRaw === "string" && !registry.has(currentStatusRaw);

	if (updates.status !== undefined) {
		if (useKeyword) {
			patch["status"] = updates.status.toLowerCase().replace("_", "-");
		} else {
			patch["status"] = registry.getByType(updates.status).symbol;
		}
	}
	if (updates.priority !== undefined) patch["priority"] = updates.priority;
	if (updates.description !== undefined)
		patch["description"] = updates.description;
	if (updates.recurrence !== undefined)
		patch["recurrence"] = updates.recurrence;
	if (updates.onCompletion !== undefined)
		patch["onCompletion"] = updates.onCompletion;
	if (updates.id !== undefined) patch["id"] = updates.id;
	if (updates.dependsOn !== undefined) patch["dependsOn"] = updates.dependsOn;
	if (updates.assignee !== undefined) patch["assignee"] = updates.assignee;
	if (updates.location !== undefined) patch["location"] = updates.location ?? null;

	if (updates.dates) {
		const d = updates.dates;
		const startDate = d.start !== undefined ? d.start : current.dates.start;
		const resolvedDue =
			d.due !== undefined
				? (resolveDueDateFromStart(d.due, startDate) ?? d.due)
				: undefined;
		if (d.start !== undefined) patch["start"] = d.start ?? null;
		if (d.created !== undefined) patch["created"] = d.created ?? null;
		if (d.scheduled !== undefined) patch["scheduled"] = d.scheduled ?? null;
		if (d.due !== undefined) patch["due"] = resolvedDue ?? null;
		if (d.done !== undefined) patch["done"] = d.done ?? null;
		if (d.cancelled !== undefined) patch["cancelled"] = d.cancelled ?? null;
		if (d.remind !== undefined) patch["remind"] = d.remind ?? null;
	}

	// Carry over fields that are not being updated
	if (!("status" in patch)) {
		if (useKeyword) {
			patch["status"] = current.status.toLowerCase().replace("_", "-");
		} else {
			patch["status"] = registry.getByType(current.status).symbol;
		}
	}

	return patch;
}

/**
 * Apply a frontmatter patch to a file using Obsidian's official
 * `fileManager.processFrontMatter()` API.
 *
 * This correctly handles multi-line values, YAML arrays, and special characters
 * that the legacy string-manipulation approach could not.
 * `null` values remove the key from frontmatter.
 */
export async function applyFrontmatterPatch(
	fileManager: FileManager,
	file: TFile,
	patch: Record<string, unknown>,
): Promise<void> {
	await fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		for (const [key, value] of Object.entries(patch)) {
			if (value === null || value === undefined) {
				delete fm[key];
			} else {
				fm[key] = value;
			}
		}
	});
}

/**
 * @deprecated Use {@link applyFrontmatterPatch} instead.
 * This function uses fragile string manipulation that cannot handle
 * multi-line YAML values or array fields correctly.
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
		if (value === null || value === undefined) {
			updated.set(key, "");
		} else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			updated.set(key, String(value));
		} else if (Array.isArray(value)) {
			updated.set(key, value.map((item) => String(item)).join(" & "));
		} else {
			updated.set(key, JSON.stringify(value));
		}
	}

	const resultLines: string[] = [];
	const handled = new Set<string>();
	let skippingContinuation = false;

	for (const line of lines) {
		if (skippingContinuation) {
			if (/^\s+/u.test(line)) {
				continue;
			}
			skippingContinuation = false;
		}
		const keyMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)/u);
		if (keyMatch) {
			const key = keyMatch[1] ?? "";
			if (updated.has(key)) {
				handled.add(key);
				skippingContinuation = true;
				const newVal = updated.get(key) ?? "";
				if (newVal !== "") {
					resultLines.push(`${key}: ${newVal}`);
				}
				continue;
			}
		}
		resultLines.push(line);
	}

	for (const [key, value] of updated) {
		if (!handled.has(key) && value !== "") {
			resultLines.push(`${key}: ${value}`);
		}
	}

	const newFm = `---\n${resultLines.join("\n")}\n---\n`;
	return newFm + afterFm;
}

function dateField(value: unknown): string | null {
	if (value instanceof Date && !Number.isNaN(value.getTime())) {
		const y = value.getFullYear().toString().padStart(4, "0");
		const m = (value.getMonth() + 1).toString().padStart(2, "0");
		const d = value.getDate().toString().padStart(2, "0");
		const hh = value.getHours();
		const mm = value.getMinutes();
		if (hh === 0 && mm === 0) return `${y}-${m}-${d}`;
		return `${y}-${m}-${d} ${hh.toString().padStart(2, "0")}:${mm.toString().padStart(2, "0")}`;
	}
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (
		/^\d{4}-\d{1,2}-\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp][Mm])?)?$/u.test(trimmed)
	) {
		return normalizeTaskDateValue(trimmed);
	}
	if (timeOnlyRegex.test(trimmed)) {
		return trimmed;
	}
	return null;
}
