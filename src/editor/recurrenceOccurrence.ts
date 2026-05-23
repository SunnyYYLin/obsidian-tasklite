import { copyTaskMetadata, serializeTaskBody, serializeTaskLine, type TaskLine } from "../model/format";
import { parseRecurrenceRule, shiftTaskDates, todayString } from "../model/recurrence";
import type { StatusRegistry } from "../model/status";
import { getSubtreeLineRange, getSubtreeNodes, type TaskTreeNode } from "../model/tree";
import type { TaskLiteSettings } from "../settings";

export interface RecurrenceOccurrenceResult {
	nextLines: string[];
	warning?: string;
	skippedBecauseExisting: boolean;
}

export function buildRecurringTaskOccurrence({
	lines,
	recurringNode,
	terminatedTask,
	registry,
	settings,
	unsupportedWarning,
}: {
	lines: string[];
	recurringNode: TaskTreeNode;
	terminatedTask: TaskLine;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
	unsupportedWarning: string;
}): RecurrenceOccurrenceResult | null {
	const recurrence = recurringNode.task?.metadata.recurrence;
	const shift = parseRecurrenceRule(recurrence ?? null);
	if (!recurrence || !recurringNode.task) return null;
	if (!shift) {
		return {nextLines: [], warning: unsupportedWarning, skippedBecauseExisting: false};
	}

	const recurringSubtree = getSubtreeNodes(recurringNode);
	const nextTask = makeNextOccurrence(recurringNode.task, terminatedTask, registry, settings, shift);
	const nextLines = settings.copySubtasksOnRecurrence
		? copySubtreeForNextOccurrence(recurringSubtree, recurringNode, nextTask, registry)
		: [serializeTaskLine(nextTask)];

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
	terminated: TaskLine,
	registry: StatusRegistry,
	settings: TaskLiteSettings,
	shift: Parameters<typeof shiftTaskDates>[1],
): TaskLine {
	const metadata = copyTaskMetadata(original.metadata);
	const terminatedOn = terminated.metadata.dates.done ?? terminated.metadata.dates.cancelled ?? todayString();
	metadata.dates = shiftTaskDates(metadata.dates, shift, terminatedOn);
	metadata.dates.done = null;
	metadata.dates.cancelled = null;
	metadata.blockLink = null;
	metadata.id = null;
	metadata.dependsOn = null;
	if (settings.setCreatedDate) {
		metadata.dates.created = todayString();
	}
	return {
		...original,
		status: registry.recurrenceStatus(terminated.status),
		metadata,
		original: "",
	};
}

function copySubtreeForNextOccurrence(
	subtree: TaskTreeNode[],
	root: TaskTreeNode,
	nextTask: TaskLine,
	registry: StatusRegistry,
): string[] {
	return subtree.map((node) => {
		if (node.lineNumber === root.lineNumber) {
			return serializeTaskLine(nextTask);
		}
		if (!node.task) {
			return node.original;
		}
		const metadata = copyTaskMetadata(node.task.metadata);
		metadata.dates.done = null;
		metadata.dates.cancelled = null;
		metadata.blockLink = null;
		metadata.id = null;
		metadata.dependsOn = null;
		return `${node.task.indentation}${node.task.listMarker} [${registry.get(" ").symbol}] ${serializeTaskBody(metadata)}`.trimEnd();
	});
}
