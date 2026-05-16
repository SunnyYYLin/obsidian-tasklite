import type { CachedMetadata } from "obsidian";
import { copyTaskMetadata, serializeTaskBody, serializeTaskLine, type TaskLine } from "../model/format";
import { parseRecurrenceRule, shiftTaskDates, todayString } from "../model/recurrence";
import { getSubtreeLineRange, getSubtreeNodes, buildTaskTree, type TaskTreeNode } from "../model/tree";
import type { StatusRegistry } from "../model/status";
import type { TasksLiteSettings } from "../settings";

export interface ToggleResult {
	fromLine: number;
	toLine: number;
	replacement: string[];
	warning?: string;
}

export function toggleTaskAtLine({
	lines,
	lineNumber,
	metadata,
	registry,
	settings,
}: {
	lines: string[];
	lineNumber: number;
	metadata: CachedMetadata | null | undefined;
	registry: StatusRegistry;
	settings: TasksLiteSettings;
}): ToggleResult | null {
	const tree = buildTaskTree(lines, metadata, registry);
	const node = tree.byLine.get(lineNumber);
	if (!node) return null;

	if (!node.task) {
		return togglePlainCheckbox(node, registry);
	}

	const toggledTask = toggleTask(node.task, registry, settings);
	const subtree = getSubtreeNodes(node);
	const range = getSubtreeLineRange(node);
	const originalSubtreeLines = subtree.map((item) => (item.lineNumber === node.lineNumber ? serializeTaskLine(toggledTask) : item.original));

	const recurrence = node.task.metadata.recurrence;
	const shift = parseRecurrenceRule(recurrence);
	const reachedDone = toggledTask.status.type === "DONE" && node.task.status.type !== "DONE";
	if (!reachedDone || !recurrence) {
		return {fromLine: range.from, toLine: range.to, replacement: originalSubtreeLines};
	}
	if (!shift) {
		return {
			fromLine: range.from,
			toLine: range.to,
			replacement: originalSubtreeLines,
			warning: "TasksLite: unsupported recurrence rule; toggled without creating the next copy.",
		};
	}

	const nextTask = makeNextOccurrence(node.task, toggledTask, registry, settings, shift);
	const nextLines = settings.copySubtasksOnRecurrence
		? copySubtreeForNextOccurrence(subtree, node, nextTask, registry)
		: [serializeTaskLine(nextTask)];

	return {
		fromLine: range.from,
		toLine: range.to,
		replacement: [...nextLines, ...originalSubtreeLines],
	};
}

function togglePlainCheckbox(node: TaskTreeNode, registry: StatusRegistry): ToggleResult | null {
	if (node.statusCharacter === null) return null;
	const current = registry.get(node.statusCharacter);
	const next = registry.next(current);
	const replacement = node.original.replace(/\[(.)\]/u, `[${next.symbol}]`);
	return {fromLine: node.lineNumber, toLine: node.lineNumber, replacement: [replacement]};
}

function toggleTask(task: TaskLine, registry: StatusRegistry, settings: TasksLiteSettings): TaskLine {
	const nextStatus = registry.next(task.status);
	const metadata = copyTaskMetadata(task.metadata);
	if (nextStatus.type === "DONE") {
		if (settings.setDoneDate && task.status.type !== "DONE") metadata.dates.done = todayString();
	} else {
		metadata.dates.done = null;
	}
	if (nextStatus.type === "CANCELLED") {
		if (settings.setCancelledDate && task.status.type !== "CANCELLED") metadata.dates.cancelled = todayString();
	} else {
		metadata.dates.cancelled = null;
	}
	return {...task, status: nextStatus, metadata};
}

function makeNextOccurrence(
	original: TaskLine,
	completed: TaskLine,
	registry: StatusRegistry,
	settings: TasksLiteSettings,
	shift: Parameters<typeof shiftTaskDates>[1],
): TaskLine {
	const metadata = copyTaskMetadata(original.metadata);
	metadata.dates = shiftTaskDates(metadata.dates, shift);
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
		status: registry.recurrenceStatus(completed.status),
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
