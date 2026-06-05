import type { StatusConfiguration, StatusRegistry, StatusType } from "./status";

/** Priority levels, ordered from highest to lowest. */
export type TaskPriority = "highest" | "high" | "medium" | "low" | "lowest";

/** Behaviour to apply when a task is finished. */
export type OnCompletionAction = "delete" | "keep";

export const TASK_SYMBOLS = {
	priority: {
		highest: "🔺",
		high: "⏫",
		medium: "🔼",
		low: "🔽",
		lowest: "⏬",
	},
	start: "🛫",
	created: "➕",
	scheduled: "⏳",
	due: "📅",
	done: "✅",
	cancelled: "❌",
	recurrence: "🔁",
	onCompletion: "🏁",
	dependsOn: "⛔",
	id: "🆔",
	assignee: "👤",
	remind: "⏰",
};

export interface TaskDates {
	start: string | null;
	created: string | null;
	scheduled: string | null;
	due: string | null;
	done: string | null;
	cancelled: string | null;
	remind: string | null;
}

export interface TaskData {
	status: StatusType;
	description: string;
	priority: TaskPriority | null;
	dates: TaskDates;
	recurrence: string | null;
	onCompletion: OnCompletionAction | null;
	dependsOn: string | null;
	id: string | null;
	assignee: string[];
	blockLink: string | null;
	tags: string[];
	/** Raw remaining text not matched by any extractor. */
	unmatched: string | null;
}

export interface TaskLine {
	listMarker: string;
	data: TaskData;
	original: string;
}

export const taskLineRegex = /^([\s\t>]*)([-*+]|[0-9]+[.)]) +\[(.)\] *(.*)$/u;
export const listItemRegex =
	/^([\s\t>]*)([-*+]|[0-9]+[.)]) *(?:\[(.)\] *)?(.*)$/u;
const dateRegex =
	"\\d{4}-\\d{2}-\\d{2}(?: \\d{1,2}:\\d{2}(?:\\s?[AaPp][Mm])?)?";
const blockLinkRegex = / \^[a-zA-Z0-9-]+$/u;
const tagRegex = /(^|\s)#[^ !@#$%^&*(),.?":{}|<>]+/g;

// ---------------------------------------------------------------------------
// Extractor pipeline
// ---------------------------------------------------------------------------

/**
 * A field extractor for the task body parsing pipeline.
 *
 * Extractors are tried in order. When one matches, it returns the cleaned
 * description and the pipeline restarts from the beginning. Any content not
 * matched by an extractor — including unknown emoji fields — is preserved
 * as the task description.
 */
export interface FieldExtractor {
	/** Human-readable label (e.g. the emoji symbol). */
	readonly label?: string;
	/**
	 * Try to extract a field from the description.
	 * @returns `[cleanedDescription, true]` if matched, `[originalDescription, false]` otherwise.
	 */
	extract(description: string, data: TaskData): [string, boolean];
}

/** Create an extractor for a date field (📅, ⏳, ✅, etc.). */
export function createDateExtractor(
	key: keyof TaskDates,
	symbol: string,
): FieldExtractor {
	return {
		label: symbol,
		extract(description, data) {
			const regex = new RegExp(
				`${escapeRegExp(symbol)}\\ufe0f? *(${dateRegex})`,
				"u",
			);
			const match = description.match(regex);
			if (!match) return [description, false];
			data.dates[key] = match[1] ?? null;
			return [
				description.replace(regex, "").replace(/ {2,}/gu, " ").trim(),
				true,
			];
		},
	};
}

/** Create an extractor for a simple string field (🔁, 🏁, ⛔, 🆔). */
export function createStringExtractor<
	K extends "recurrence" | "onCompletion" | "dependsOn" | "id",
>(key: K, symbol: string, valuePattern: string): FieldExtractor {
	return {
		label: symbol,
		extract(description, data) {
			const regex = new RegExp(
				`${escapeRegExp(symbol)}\\ufe0f? *(${valuePattern})`,
				"u",
			);
			const match = description.match(regex);
			if (!match) return [description, false];
			(data as unknown as Record<string, unknown>)[key] = (
				match[1] ?? ""
			).trim();
			return [
				description.replace(regex, "").replace(/ {2,}/gu, " ").trim(),
				true,
			];
		},
	};
}

/** Extractor for priority emoji (🔺⏫🔼🔽⏬), anchored at end of description. */
const priorityExtractor: FieldExtractor = {
	label: "priority",
	extract(description, data) {
		const priorities = Object.values(TASK_SYMBOLS.priority).join("|");
		const regex = new RegExp(` ?(${priorities})$`, "u");
		const match = description.match(regex);
		if (!match) return [description, false];
		const emoji = match[1];
		if (emoji === "🔺") data.priority = "highest";
		else if (emoji === "⏫") data.priority = "high";
		else if (emoji === "🔼") data.priority = "medium";
		else if (emoji === "🔽") data.priority = "low";
		else if (emoji === "⏬") data.priority = "lowest";
		return [description.replace(regex, "").trim(), true];
	},
};

/** Extractor for assignee field (👤), supports `&`-separated multi-person values. */
const assigneeExtractor: FieldExtractor = {
	label: TASK_SYMBOLS.assignee,
	extract(description, data) {
		const symbol = TASK_SYMBOLS.assignee;
		const regex = new RegExp(`${escapeRegExp(symbol)}\\ufe0f? *(.+)`, "u");
		const match = description.match(regex);
		if (!match) return [description, false];
		const raw = (match[1] ?? "").trim();
		data.assignee = raw
			? raw
					.split("&")
					.map((p) => p.trim())
					.filter(Boolean)
			: [];
		return [
			description.replace(regex, "").replace(/ {2,}/gu, " ").trim(),
			true,
		];
	},
};

/**
 * Default extractor pipeline for parsing task body emoji fields.
 *
 * The order matters: done/cancelled dates are extracted before due/scheduled/
 * start/created to avoid partial matches. Priority is first because it anchors
 * at end-of-string.
 *
 * To extend with custom fields, spread and append your own extractors:
 * ```ts
 * const myExtractors = [...DEFAULT_EXTRACTORS, myCustomExtractor];
 * parseTaskBody(body, status, myExtractors);
 * ```
 *
 * Any emoji or text not matched by an extractor in the pipeline is preserved
 * as part of the task description.
 */
export const DEFAULT_EXTRACTORS: FieldExtractor[] = [
	priorityExtractor,
	createDateExtractor("done", TASK_SYMBOLS.done),
	createDateExtractor("cancelled", TASK_SYMBOLS.cancelled),
	createDateExtractor("due", TASK_SYMBOLS.due),
	createDateExtractor("scheduled", TASK_SYMBOLS.scheduled),
	createDateExtractor("start", TASK_SYMBOLS.start),
	createDateExtractor("created", TASK_SYMBOLS.created),
	createDateExtractor("remind", TASK_SYMBOLS.remind),
	createStringExtractor(
		"recurrence",
		TASK_SYMBOLS.recurrence,
		"[a-zA-Z0-9, !]+",
	),
	createStringExtractor(
		"onCompletion",
		TASK_SYMBOLS.onCompletion,
		"delete|keep",
	),
	createStringExtractor(
		"dependsOn",
		TASK_SYMBOLS.dependsOn,
		"[a-zA-Z0-9-_, ]+",
	),
	createStringExtractor("id", TASK_SYMBOLS.id, "[a-zA-Z0-9-_]+"),
	assigneeExtractor,
];

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function parseTaskLine(
	line: string,
	statusType: StatusType,
): TaskLine | null {
	const match = line.match(taskLineRegex);
	if (!match) return null;
	const listMarker = match[2] ?? "-";
	const body = (match[4] ?? "").trim();
	return {
		listMarker,
		data: parseTaskBody(body, statusType),
		original: line,
	};
}

/**
 * Parse the body (everything after the checkbox) of a task line.
 *
 * Uses an extractor pipeline to identify known emoji fields. Fields are
 * extracted iteratively until no more matches are found. Any unmatched
 * content — including unknown emoji fields — is preserved in the description.
 *
 * @param body - The raw text after the checkbox marker.
 * @param status - The task's status type.
 * @param extractors - Optional custom extractor pipeline. Defaults to `DEFAULT_EXTRACTORS`.
 */
export function parseTaskBody(
	body: string,
	status: StatusType,
	extractors?: FieldExtractor[],
): TaskData {
	const pipeline = extractors ?? DEFAULT_EXTRACTORS;
	let remaining = body.trim();

	let blockLink: string | null = null;
	const blockLinkMatch = remaining.match(blockLinkRegex);
	if (blockLinkMatch) {
		blockLink = blockLinkMatch[0].trim();
		remaining = remaining.replace(blockLinkRegex, "").trim();
	}

	const data: TaskData = {
		status,
		description: remaining,
		priority: null,
		dates: {
			start: null,
			created: null,
			scheduled: null,
			due: null,
			done: null,
			cancelled: null,
			remind: null,
		},
		recurrence: null,
		onCompletion: null,
		dependsOn: null,
		id: null,
		assignee: [],
		blockLink,
		tags: [],
		unmatched: null,
	};

	let matched = true;
	let guard = 0;
	while (matched && guard < 30) {
		guard++;
		matched = false;
		for (const extractor of pipeline) {
			const [newRemaining, didMatch] = extractor.extract(remaining, data);
			if (didMatch) {
				remaining = newRemaining;
				matched = true;
				break; // restart pipeline from the beginning
			}
		}
	}

	data.description = remaining.replace(/ {2,}/gu, " ").trim();
	data.unmatched = remaining.trim() || null;
	data.tags = extractTags(data.description);
	return data;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function serializeTaskLine(
	task: TaskLine,
	indentPrefix: string,
	registry: StatusRegistry,
): string {
	const symbol = registry.getByType(task.data.status).symbol;
	return `${indentPrefix}${task.listMarker} [${symbol}] ${serializeTaskBody(task.data)}`.trimEnd();
}

export function serializeTaskBody(data: TaskData): string {
	const parts = [data.description.trim()];
	if (data.priority) {
		let emoji = "";
		if (data.priority === "highest") emoji = "🔺";
		else if (data.priority === "high") emoji = "⏫";
		else if (data.priority === "medium") emoji = "🔼";
		else if (data.priority === "low") emoji = "🔽";
		else if (data.priority === "lowest") emoji = "⏬";
		if (emoji) parts.push(emoji);
	}
	addDate(parts, TASK_SYMBOLS.start, data.dates.start);
	addDate(parts, TASK_SYMBOLS.created, data.dates.created);
	addDate(parts, TASK_SYMBOLS.scheduled, data.dates.scheduled);
	addDate(parts, TASK_SYMBOLS.due, data.dates.due);
	addDate(parts, TASK_SYMBOLS.done, data.dates.done);
	addDate(parts, TASK_SYMBOLS.cancelled, data.dates.cancelled);
	addDate(parts, TASK_SYMBOLS.remind, data.dates.remind);
	if (data.recurrence)
		parts.push(`${TASK_SYMBOLS.recurrence} ${data.recurrence}`);
	if (data.onCompletion)
		parts.push(`${TASK_SYMBOLS.onCompletion} ${data.onCompletion}`);
	if (data.dependsOn)
		parts.push(`${TASK_SYMBOLS.dependsOn} ${data.dependsOn}`);
	if (data.id) parts.push(`${TASK_SYMBOLS.id} ${data.id}`);
	if (data.assignee && data.assignee.length > 0)
		parts.push(`${TASK_SYMBOLS.assignee} ${data.assignee.join(" & ")}`);
	if (data.blockLink) parts.push(data.blockLink);
	return parts.filter(Boolean).join(" ");
}

export function copyTaskData(data: TaskData): TaskData {
	return {
		status: data.status,
		description: data.description,
		priority: data.priority ?? null,
		dates: data.dates
			? { ...data.dates }
			: {
					start: null,
					created: null,
					scheduled: null,
					due: null,
					done: null,
					cancelled: null,
					remind: null,
				},
		recurrence: data.recurrence ?? null,
		onCompletion: data.onCompletion ?? null,
		dependsOn: data.dependsOn ?? null,
		id: data.id ?? null,
		assignee: data.assignee ? [...data.assignee] : [],
		blockLink: data.blockLink ?? null,
		tags: data.tags ? [...data.tags] : [],
		unmatched: data.unmatched ?? null,
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addDate(parts: string[], symbol: string, value: string | null): void {
	if (value) parts.push(`${symbol} ${value}`);
}

function extractTags(description: string): string[] {
	return [...description.matchAll(tagRegex)].map((match) => match[0].trim());
}

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseLineWithStatus(
	line: string,
	registry: StatusRegistry,
): TaskLine | null {
	const statusSymbol = line.match(/\[(.)\]/u)?.[1] ?? " ";
	return parseTaskLine(line, registry.get(statusSymbol).type);
}

/**
 * Normalize the indentation of a single line of text according to the vault's tab settings.
 */
export function normalizeLineIndentation(
	line: string,
	useTab: boolean,
	tabSize: number,
): string {
	const match = line.match(listItemRegex);
	if (!match) return line;

	const rawIndent = match[1] ?? "";
	const lastQuoteIdx = rawIndent.lastIndexOf(">");
	let quotePart = "";
	let indentPart = rawIndent;
	if (lastQuoteIdx >= 0) {
		if (
			rawIndent[lastQuoteIdx + 1] === " " ||
			rawIndent[lastQuoteIdx + 1] === "\t"
		) {
			quotePart = rawIndent.slice(0, lastQuoteIdx + 2);
			indentPart = rawIndent.slice(lastQuoteIdx + 2);
		} else {
			quotePart = rawIndent.slice(0, lastQuoteIdx + 1);
			indentPart = rawIndent.slice(lastQuoteIdx + 1);
		}
	}

	const spacesCount = indentPart.replace(/\t/gu, " ".repeat(tabSize)).length;

	let newIndentPart = "";
	if (useTab) {
		const tabs = Math.floor(spacesCount / tabSize);
		const remainder = spacesCount % tabSize;
		newIndentPart = "\t".repeat(tabs) + " ".repeat(remainder);
	} else {
		newIndentPart = " ".repeat(spacesCount);
	}

	const newIndent = quotePart + newIndentPart;
	if (rawIndent !== newIndent) {
		return newIndent + line.slice(rawIndent.length);
	}
	return line;
}
