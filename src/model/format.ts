import type { StatusConfiguration, StatusRegistry, StatusType } from "./status";

/** Priority levels, ordered from highest to lowest. */
export type TaskPriority = "🔺" | "⏫" | "🔼" | "🔽" | "⏬";

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
};

export interface TaskDates {
	start: string | null;
	created: string | null;
	scheduled: string | null;
	due: string | null;
	done: string | null;
	cancelled: string | null;
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
}

export interface TaskLine {
	listMarker: string;
	data: TaskData;
	original: string;
}

export const taskLineRegex = /^([\s\t>]*)([-*+]|[0-9]+[.)]) +\[(.)\] *(.*)$/u;
export const listItemRegex = /^([\s\t>]*)([-*+]|[0-9]+[.)]) *(?:\[(.)\] *)?(.*)$/u;
const dateRegex = "\\d{4}-\\d{2}-\\d{2}";
const blockLinkRegex = / \^[a-zA-Z0-9-]+$/u;
const tagRegex = /(^|\s)#[^ !@#$%^&*(),.?":{}|<>]+/g;

export function parseTaskLine(line: string, statusType: StatusType): TaskLine | null {
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

export function parseTaskBody(body: string, status: StatusType): TaskData {
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
		dates: {start: null, created: null, scheduled: null, due: null, done: null, cancelled: null},
		recurrence: null,
		onCompletion: null,
		dependsOn: null,
		id: null,
		assignee: [],
		blockLink,
		tags: [],
	};

	let matched = true;
	let guard = 0;
	while (matched && guard < 30) {
		guard++;
		matched = false;
		matched = extractPriority(data) || matched;
		matched = extractDate(data, "done", TASK_SYMBOLS.done) || matched;
		matched = extractDate(data, "cancelled", TASK_SYMBOLS.cancelled) || matched;
		matched = extractDate(data, "due", TASK_SYMBOLS.due) || matched;
		matched = extractDate(data, "scheduled", TASK_SYMBOLS.scheduled) || matched;
		matched = extractDate(data, "start", TASK_SYMBOLS.start) || matched;
		matched = extractDate(data, "created", TASK_SYMBOLS.created) || matched;
		matched = extractString(data, "recurrence", TASK_SYMBOLS.recurrence, "[a-zA-Z0-9, !]+") || matched;
		matched = extractString(data, "onCompletion", TASK_SYMBOLS.onCompletion, "delete|keep") || matched;
		matched = extractString(data, "dependsOn", TASK_SYMBOLS.dependsOn, "[a-zA-Z0-9-_, ]+") || matched;
		matched = extractString(data, "id", TASK_SYMBOLS.id, "[a-zA-Z0-9-_]+") || matched;
		matched = extractAssignee(data) || matched;
	}
	data.description = data.description.replace(/ {2,}/gu, " ").trim();
	data.tags = extractTags(data.description);
	return data;

	function extractPriority(target: TaskData): boolean {
		const priorities = Object.values(TASK_SYMBOLS.priority).join("|");
		const regex = new RegExp(` ?(${priorities})$`, "u");
		const match = target.description.match(regex);
		if (!match) return false;
		target.priority = (match[1] ?? null) as TaskPriority | null;
		target.description = target.description.replace(regex, "").trim();
		return true;
	}

	function extractAssignee(target: TaskData): boolean {
		const symbol = TASK_SYMBOLS.assignee;
		const regex = new RegExp(`${escapeRegExp(symbol)}\\ufe0f? *(.+)`, "u");
		const match = target.description.match(regex);
		if (!match) return false;
		const raw = (match[1] ?? "").trim();
		target.assignee = raw ? raw.split("&").map((p) => p.trim()).filter(Boolean) : [];
		target.description = target.description.replace(regex, "").replace(/ {2,}/gu, " ").trim();
		return true;
	}
}

export function serializeTaskLine(task: TaskLine, indentPrefix: string, registry: StatusRegistry): string {
	const symbol = registry.getByType(task.data.status).symbol;
	return `${indentPrefix}${task.listMarker} [${symbol}] ${serializeTaskBody(task.data)}`.trimEnd();
}

export function serializeTaskBody(data: TaskData): string {
	const parts = [data.description.trim()];
	if (data.priority) parts.push(data.priority);
	addDate(parts, TASK_SYMBOLS.start, data.dates.start);
	addDate(parts, TASK_SYMBOLS.created, data.dates.created);
	addDate(parts, TASK_SYMBOLS.scheduled, data.dates.scheduled);
	addDate(parts, TASK_SYMBOLS.due, data.dates.due);
	addDate(parts, TASK_SYMBOLS.done, data.dates.done);
	addDate(parts, TASK_SYMBOLS.cancelled, data.dates.cancelled);
	if (data.recurrence) parts.push(`${TASK_SYMBOLS.recurrence} ${data.recurrence}`);
	if (data.onCompletion) parts.push(`${TASK_SYMBOLS.onCompletion} ${data.onCompletion}`);
	if (data.dependsOn) parts.push(`${TASK_SYMBOLS.dependsOn} ${data.dependsOn}`);
	if (data.id) parts.push(`${TASK_SYMBOLS.id} ${data.id}`);
	if (data.assignee && data.assignee.length > 0) parts.push(`${TASK_SYMBOLS.assignee} ${data.assignee.join(" & ")}`);
	if (data.blockLink) parts.push(data.blockLink);
	return parts.filter(Boolean).join(" ");
}

export function copyTaskData(data: TaskData): TaskData {
	return {
		status: data.status,
		description: data.description,
		priority: data.priority ?? null,
		dates: data.dates ? { ...data.dates } : {start: null, created: null, scheduled: null, due: null, done: null, cancelled: null},
		recurrence: data.recurrence ?? null,
		onCompletion: data.onCompletion ?? null,
		dependsOn: data.dependsOn ?? null,
		id: data.id ?? null,
		assignee: data.assignee ? [...data.assignee] : [],
		blockLink: data.blockLink ?? null,
		tags: data.tags ? [...data.tags] : [],
	};
}

function extractDate(data: TaskData, key: keyof TaskDates, symbol: string): boolean {
	const regex = new RegExp(`${escapeRegExp(symbol)}\\ufe0f? *(${dateRegex})`, "u");
	const match = data.description.match(regex);
	if (!match) return false;
	data.dates[key] = match[1] ?? null;
	data.description = data.description.replace(regex, "").replace(/ {2,}/gu, " ").trim();
	return true;
}

function extractString<K extends "recurrence" | "onCompletion" | "dependsOn" | "id">(data: TaskData, key: K, symbol: string, valuePattern: string): boolean {
	const regex = new RegExp(`${escapeRegExp(symbol)}\\ufe0f? *(${valuePattern})`, "u");
	const match = data.description.match(regex);
	if (!match) return false;
	(data as unknown as Record<string, unknown>)[key] = (match[1] ?? "").trim();
	data.description = data.description.replace(regex, "").replace(/ {2,}/gu, " ").trim();
	return true;
}

function addDate(parts: string[], symbol: string, value: string | null): void {
	if (value) parts.push(`${symbol} ${value}`);
}

function extractTags(description: string): string[] {
	return [...description.matchAll(tagRegex)].map((match) => match[0].trim());
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseLineWithStatus(line: string, registry: StatusRegistry): TaskLine | null {
	const statusSymbol = line.match(/\[(.)\]/u)?.[1] ?? " ";
	return parseTaskLine(line, registry.get(statusSymbol).type);
}

/**
 * Normalize the indentation of a single line of text according to the vault's tab settings.
 */
export function normalizeLineIndentation(line: string, useTab: boolean, tabSize: number): string {
	const match = line.match(listItemRegex);
	if (!match) return line;

	const rawIndent = match[1] ?? "";
	const lastQuoteIdx = rawIndent.lastIndexOf(">");
	let quotePart = "";
	let indentPart = rawIndent;
	if (lastQuoteIdx >= 0) {
		if (rawIndent[lastQuoteIdx + 1] === " " || rawIndent[lastQuoteIdx + 1] === "\t") {
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
