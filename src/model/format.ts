import type { StatusConfiguration } from "./status";

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
};

export interface TaskDates {
	start: string | null;
	created: string | null;
	scheduled: string | null;
	due: string | null;
	done: string | null;
	cancelled: string | null;
}

export interface TaskMetadata {
	description: string;
	priority: string | null;
	dates: TaskDates;
	recurrence: string | null;
	onCompletion: string | null;
	id: string | null;
	dependsOn: string | null;
	blockLink: string | null;
	tags: string[];
}

export interface TaskLine {
	indentation: string;
	listMarker: string;
	status: StatusConfiguration;
	metadata: TaskMetadata;
	original: string;
}

export const taskLineRegex = /^([\s\t>]*)([-*+]|[0-9]+[.)]) +\[(.?)\] *(.*)$/u;
export const listItemRegex = /^([\s\t>]*)([-*+]|[0-9]+[.)]) *(?:\[(.?)\] *)?(.*)$/u;
const dateRegex = "\\d{4}-\\d{2}-\\d{2}";
const blockLinkRegex = / \^[a-zA-Z0-9-]+$/u;
const tagRegex = /(^|\s)#[^ !@#$%^&*(),.?":{}|<>]+/g;

export function parseTaskLine(line: string, status: StatusConfiguration): TaskLine | null {
	const match = line.match(taskLineRegex);
	if (!match) return null;
	const indentation = match[1] ?? "";
	const listMarker = match[2] ?? "-";
	const body = (match[4] ?? "").trim();
	return {
		indentation,
		listMarker,
		status,
		metadata: parseTaskBody(body),
		original: line,
	};
}

export function parseTaskBody(body: string): TaskMetadata {
	let remaining = body.trim();
	let blockLink: string | null = null;
	const blockLinkMatch = remaining.match(blockLinkRegex);
	if (blockLinkMatch) {
		blockLink = blockLinkMatch[0].trim();
		remaining = remaining.replace(blockLinkRegex, "").trim();
	}

	const metadata: TaskMetadata = {
		description: remaining,
		priority: null,
		dates: {start: null, created: null, scheduled: null, due: null, done: null, cancelled: null},
		recurrence: null,
		onCompletion: null,
		id: null,
		dependsOn: null,
		blockLink,
		tags: [],
	};

	let matched = true;
	let guard = 0;
	while (matched && guard < 30) {
		guard++;
		matched = false;
		matched = extractPriority(metadata) || matched;
		matched = extractDate(metadata, "done", TASK_SYMBOLS.done) || matched;
		matched = extractDate(metadata, "cancelled", TASK_SYMBOLS.cancelled) || matched;
		matched = extractDate(metadata, "due", TASK_SYMBOLS.due) || matched;
		matched = extractDate(metadata, "scheduled", TASK_SYMBOLS.scheduled) || matched;
		matched = extractDate(metadata, "start", TASK_SYMBOLS.start) || matched;
		matched = extractDate(metadata, "created", TASK_SYMBOLS.created) || matched;
		matched = extractString(metadata, "recurrence", TASK_SYMBOLS.recurrence, "[a-zA-Z0-9, !]+") || matched;
		matched = extractString(metadata, "onCompletion", TASK_SYMBOLS.onCompletion, "[a-zA-Z]+") || matched;
		matched = extractString(metadata, "dependsOn", TASK_SYMBOLS.dependsOn, "[a-zA-Z0-9-_, ]+") || matched;
		matched = extractString(metadata, "id", TASK_SYMBOLS.id, "[a-zA-Z0-9-_]+") || matched;
	}
	metadata.tags = extractTags(metadata.description);
	return metadata;

	function extractPriority(target: TaskMetadata): boolean {
		const priorities = Object.values(TASK_SYMBOLS.priority).join("|");
		const regex = new RegExp(` ?(${priorities})$`, "u");
		const match = target.description.match(regex);
		if (!match) return false;
		target.priority = match[1] ?? null;
		target.description = target.description.replace(regex, "").trim();
		return true;
	}
}

export function serializeTaskLine(task: TaskLine): string {
	return `${task.indentation}${task.listMarker} [${task.status.symbol}] ${serializeTaskBody(task.metadata)}`.trimEnd();
}

export function serializeTaskBody(metadata: TaskMetadata): string {
	const parts = [metadata.description.trim()];
	if (metadata.priority) parts.push(metadata.priority);
	addDate(parts, TASK_SYMBOLS.start, metadata.dates.start);
	addDate(parts, TASK_SYMBOLS.created, metadata.dates.created);
	addDate(parts, TASK_SYMBOLS.scheduled, metadata.dates.scheduled);
	addDate(parts, TASK_SYMBOLS.due, metadata.dates.due);
	addDate(parts, TASK_SYMBOLS.done, metadata.dates.done);
	addDate(parts, TASK_SYMBOLS.cancelled, metadata.dates.cancelled);
	if (metadata.recurrence) parts.push(`${TASK_SYMBOLS.recurrence} ${metadata.recurrence}`);
	if (metadata.onCompletion) parts.push(`${TASK_SYMBOLS.onCompletion} ${metadata.onCompletion}`);
	if (metadata.dependsOn) parts.push(`${TASK_SYMBOLS.dependsOn} ${metadata.dependsOn}`);
	if (metadata.id) parts.push(`${TASK_SYMBOLS.id} ${metadata.id}`);
	if (metadata.blockLink) parts.push(metadata.blockLink);
	return parts.filter(Boolean).join(" ");
}

export function copyTaskMetadata(metadata: TaskMetadata): TaskMetadata {
	return {
		description: metadata.description,
		priority: metadata.priority,
		dates: {...metadata.dates},
		recurrence: metadata.recurrence,
		onCompletion: metadata.onCompletion,
		id: metadata.id,
		dependsOn: metadata.dependsOn,
		blockLink: metadata.blockLink,
		tags: [...metadata.tags],
	};
}

function extractDate(metadata: TaskMetadata, key: keyof TaskDates, symbol: string): boolean {
	const regex = new RegExp(` ?${escapeRegExp(symbol)}\\ufe0f? *(${dateRegex})$`, "u");
	const match = metadata.description.match(regex);
	if (!match) return false;
	metadata.dates[key] = match[1] ?? null;
	metadata.description = metadata.description.replace(regex, "").trim();
	return true;
}

function extractString(metadata: TaskMetadata, key: "recurrence" | "onCompletion" | "id" | "dependsOn", symbol: string, valuePattern: string): boolean {
	const regex = new RegExp(` ?${escapeRegExp(symbol)}\\ufe0f? *(${valuePattern})$`, "u");
	const match = metadata.description.match(regex);
	if (!match) return false;
	metadata[key] = (match[1] ?? "").trim();
	metadata.description = metadata.description.replace(regex, "").trim();
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
