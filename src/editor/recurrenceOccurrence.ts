import type { App } from "obsidian";
import { copyTaskData, serializeTaskLine, type TaskLine, type TaskData } from "../model/format";
import { parseRecurrenceRule, nextRecurrenceDates, todayString, type RecurrenceRule } from "../model/recurrence";
import type { StatusRegistry } from "../model/status";
import { getSubtreeLineRange, getSubtreeNodes, taskDepth, type TaskTreeNode } from "../model/tree";
import type { TaskLiteSettings } from "../settings";
import { getIndentPrefix } from "./toggle";

export interface RecurrenceOccurrenceResult {
	nextLines: string[];
	warning?: string;
	skippedBecauseExisting: boolean;
}

export function buildRecurringTaskOccurrence({
	lines,
	recurringNode,
	terminatedTask,
	app,
	registry,
	settings,
	unsupportedWarning,
}: {
	lines: string[];
	recurringNode: TaskTreeNode;
	terminatedTask: TaskData;
	app?: App;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
	unsupportedWarning: string;
}): RecurrenceOccurrenceResult | null {
	const recurrence = recurringNode.task?.data.recurrence;
	const shift = parseRecurrenceRule(recurrence ?? null);
	if (!recurrence || !recurringNode.task) return null;
	if (!shift) {
		return {nextLines: [], warning: unsupportedWarning, skippedBecauseExisting: false};
	}

	const recurringSubtree = getSubtreeNodes(recurringNode);
	const nextTask = makeNextOccurrence(recurringNode.task, terminatedTask, registry, settings, shift);
	const nextLines = settings.copySubtasksOnRecurrence
		? copySubtreeForNextOccurrence(recurringSubtree, recurringNode, nextTask, registry, app, lines)
		: [serializeTaskLine(nextTask, getIndentPrefix(taskDepth(recurringNode), app, lines), registry)];

	const insertionLine = getSubtreeLineRange(recurringNode).from;
	return {
		nextLines,
		skippedBecauseExisting: hasExistingOccurrence(lines, insertionLine, nextLines),
	};
}

function hasExistingOccurrence(lines: string[], insertionLine: number, nextLines: string[]): boolean {
	if (nextLines.length === 0 || insertionLine < nextLines.length) return false;
	const existing = lines.slice(insertionLine - nextLines.length, insertionLine);
	return existing.length === nextLines.length && existing.every((line, index) => line === nextLines[index]);
}

function makeNextOccurrence(
	original: TaskLine,
	terminated: TaskData,
	registry: StatusRegistry,
	settings: TaskLiteSettings,
	shift: RecurrenceRule,
): TaskLine {
	const data = copyTaskData(original.data);
	const terminatedOn = terminated.dates.done ?? terminated.dates.cancelled ?? todayString();
	data.dates = nextRecurrenceDates(data.dates, shift, terminatedOn);
	data.dates.done = null;
	data.dates.cancelled = null;
	data.blockLink = null;
	data.id = null;
	data.dependsOn = null;
	if (settings.setCreatedDate) {
		data.dates.created = todayString();
	}
	const nextStatus = registry.recurrenceStatus(registry.getByType(terminated.status).symbol);
	data.status = nextStatus.type;
	return {
		...original,
		data,
		original: "",
	};
}

function copySubtreeForNextOccurrence(
	subtree: TaskTreeNode[],
	root: TaskTreeNode,
	nextTask: TaskLine,
	registry: StatusRegistry,
	app: App | undefined,
	lines: string[],
): string[] {
	return subtree.map((node) => {
		const depth = taskDepth(node);
		const indent = getIndentPrefix(depth, app, lines);
		if (node.lineNumber === root.lineNumber) {
			return serializeTaskLine(nextTask, indent, registry);
		}
		if (!node.task) {
			return node.original;
		}
		const data = copyTaskData(node.task.data);
		data.dates.done = null;
		data.dates.cancelled = null;
		data.blockLink = null;
		data.id = null;
		data.dependsOn = null;
		const todoStatus = registry.get(" ");
		data.status = todoStatus.type;
		return serializeTaskLine({
			...node.task,
			data,
		}, indent, registry);
	});
}
