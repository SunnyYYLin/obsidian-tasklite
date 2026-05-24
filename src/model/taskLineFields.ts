import { copyTaskMetadata, parseTaskLine, serializeTaskLine, type TaskLine, type TaskMetadata } from "./format";
import type { StatusRegistry } from "./status";

export interface TaskLineFields {
	statusSymbol: string;
	description: string;
	start: string;
	created: string;
	scheduled: string;
	due: string;
	done: string;
	cancelled: string;
	recurrence: string;
	onCompletion: string;
	priority: string;
	id: string;
	dependsOn: string;
	blockLink: string;
}

export function fieldsFromTaskLine(line: string, registry: StatusRegistry): TaskLineFields {
	const task = normalizeTaskLine(line, registry);
	return {
		statusSymbol: task.status.symbol,
		description: task.metadata.description,
		start: task.metadata.dates.start ?? "",
		created: task.metadata.dates.created ?? "",
		scheduled: task.metadata.dates.scheduled ?? "",
		due: task.metadata.dates.due ?? "",
		done: task.metadata.dates.done ?? "",
		cancelled: task.metadata.dates.cancelled ?? "",
		recurrence: task.metadata.recurrence ?? "",
		onCompletion: task.metadata.onCompletion ?? "",
		priority: task.metadata.priority ?? "",
		id: task.metadata.id ?? "",
		dependsOn: task.metadata.dependsOn ?? "",
		blockLink: task.metadata.blockLink ?? "",
	};
}

export function taskLineFromFields(fields: TaskLineFields, registry: StatusRegistry, templateLine = ""): string {
	const status = registry.get(fields.statusSymbol);
	const templateTask = normalizeTaskLine(templateLine, registry);
	const metadata: TaskMetadata = {
		description: fields.description.trim(),
		priority: emptyToNull(fields.priority),
		dates: {
			start: emptyToNull(fields.start),
			created: emptyToNull(fields.created),
			scheduled: emptyToNull(fields.scheduled),
			due: emptyToNull(fields.due),
			done: status.type === "CANCELLED" ? null : emptyToNull(fields.done),
			cancelled: status.type === "DONE" ? null : emptyToNull(fields.cancelled),
		},
		recurrence: emptyToNull(fields.recurrence),
		onCompletion: emptyToNull(fields.onCompletion),
		id: emptyToNull(fields.id),
		dependsOn: emptyToNull(fields.dependsOn),
		blockLink: emptyToNull(fields.blockLink),
		tags: [],
	};
	const task: TaskLine = {
		indentation: templateTask.indentation,
		listMarker: templateTask.listMarker || "-",
		status,
		metadata,
		original: "",
	};
	return serializeTaskLine(task);
}

function normalizeTaskLine(line: string, registry: StatusRegistry): TaskLine {
	const statusSymbol = line.match(/\[(.)\]/u)?.[1] ?? " ";
	const parsed = parseTaskLine(line, registry.get(statusSymbol));
	if (parsed) {
		return {...parsed, metadata: copyTaskMetadata(parsed.metadata)};
	}
	return {
		indentation: "",
		listMarker: "-",
		status: registry.get(" "),
		metadata: {
			description: line.replace(/^\s*(?:[-*+]|\d+[.)])\s*(?:\[[^\]]\])?\s*/u, "").trim(),
			priority: null,
			dates: {start: null, created: null, scheduled: null, due: null, done: null, cancelled: null},
			recurrence: null,
			onCompletion: null,
			id: null,
			dependsOn: null,
			blockLink: null,
			tags: [],
		},
		original: line,
	};
}

function emptyToNull(value: string): string | null {
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}
