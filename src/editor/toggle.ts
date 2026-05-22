import type { CachedMetadata } from "obsidian";
import { copyTaskMetadata, serializeTaskBody, serializeTaskLine, type TaskLine } from "../model/format";
import { parseRecurrenceRule, shiftTaskDates, todayString } from "../model/recurrence";
import { getSubtreeLineRange, getSubtreeNodes, buildTaskTree, type TaskTreeNode } from "../model/tree";
import { applyTaskStatus, toggleTaskStatus } from "../model/taskState";
import type { StatusRegistry } from "../model/status";
import type { TaskLiteSettings } from "../settings";

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
	settings: TaskLiteSettings;
}): ToggleResult | null {
	const tree = buildTaskTree(lines, metadata, registry);
	const node = tree.byLine.get(lineNumber);
	if (!node) return null;

	if (!node.task) {
		return togglePlainCheckbox(node, registry);
	}

	const toggledTask = toggleTaskStatus(node.task, registry, settings);
	const subtree = getSubtreeNodes(node);
	const range = getSubtreeLineRange(node);
	const changedTasks = new Map<number, TaskLine>([[node.lineNumber, toggledTask]]);
	const replacementByLine = new Map<number, string>([[node.lineNumber, serializeTaskLine(toggledTask)]]);
	completeParentTasks(node, changedTasks, replacementByLine, registry, settings);
	const recurringNode = findRecurringCompletedNode(node, changedTasks);
	const recurringRange = recurringNode ? getSubtreeLineRange(recurringNode) : null;
	const replacementRange = getReplacementRange(recurringRange ?? range, replacementByLine);
	const originalLines = lines
		.slice(replacementRange.from, replacementRange.to + 1)
		.map((line, index) => replacementByLine.get(replacementRange.from + index) ?? line);

	const completedTask = recurringNode ? changedTasks.get(recurringNode.lineNumber) : toggledTask;
	const recurrence = recurringNode?.task?.metadata.recurrence ?? node.task.metadata.recurrence;
	const shift = parseRecurrenceRule(recurrence);
	const reachedDone =
		Boolean(completedTask && recurringNode?.task) &&
		completedTask!.status.type === "DONE" &&
		recurringNode!.task!.status.type !== "DONE";
	if (!reachedDone || !recurrence) {
		return {fromLine: replacementRange.from, toLine: replacementRange.to, replacement: originalLines};
	}
	if (!shift) {
		return {
			fromLine: replacementRange.from,
			toLine: replacementRange.to,
			replacement: originalLines,
			warning: "TaskLite: unsupported recurrence rule; toggled without creating the next copy.",
		};
	}

	const recurringSubtree = getSubtreeNodes(recurringNode ?? node);
	const nextTask = makeNextOccurrence((recurringNode ?? node).task!, completedTask!, registry, settings, shift);
	const nextLines = settings.copySubtasksOnRecurrence
		? copySubtreeForNextOccurrence(recurringSubtree, recurringNode ?? node, nextTask, registry)
		: [serializeTaskLine(nextTask)];

	return {
		fromLine: replacementRange.from,
		toLine: replacementRange.to,
		replacement: [...nextLines, ...originalLines],
	};
}

function togglePlainCheckbox(node: TaskTreeNode, registry: StatusRegistry): ToggleResult | null {
	if (node.statusCharacter === null) return null;
	const current = registry.get(node.statusCharacter);
	const next = registry.next(current);
	const replacement = node.original.replace(/\[(.)\]/u, `[${next.symbol}]`);
	return {fromLine: node.lineNumber, toLine: node.lineNumber, replacement: [replacement]};
}

function completeParentTasks(
	node: TaskTreeNode,
	changedTasks: Map<number, TaskLine>,
	replacementByLine: Map<number, string>,
	registry: StatusRegistry,
	settings: TaskLiteSettings,
): void {
	let parent = node.parent;
	while (parent?.task && parent.task.status.type !== "DONE" && areAllTaskChildrenDone(parent, replacementByLine, registry)) {
		const completedParent = applyTaskStatus(parent.task, registry.get("x"), settings);
		changedTasks.set(parent.lineNumber, completedParent);
		replacementByLine.set(parent.lineNumber, serializeTaskLine(completedParent));
		parent = parent.parent;
	}
}

function findRecurringCompletedNode(node: TaskTreeNode, changedTasks: Map<number, TaskLine>): TaskTreeNode | null {
	let current: TaskTreeNode | null = node;
	while (current) {
		const changedTask = changedTasks.get(current.lineNumber);
		if (current.task?.metadata.recurrence && changedTask?.status.type === "DONE" && current.task.status.type !== "DONE") {
			return current;
		}
		current = current.parent;
	}
	return null;
}

function areAllTaskChildrenDone(parent: TaskTreeNode, replacementByLine: Map<number, string>, registry: StatusRegistry): boolean {
	const taskChildren = parent.children.filter((child) => child.task);
	if (taskChildren.length === 0) return false;
	return taskChildren.every((child) => {
		if (!child.task) return false;
		const replacement = replacementByLine.get(child.lineNumber);
		if (!replacement) return child.task.status.type === "DONE";
		const statusSymbol = replacement.match(/\[(.)\]/u)?.[1] ?? child.task.status.symbol;
		return registry.get(statusSymbol).type === "DONE";
	});
}

function getReplacementRange(
	range: {from: number; to: number},
	replacementByLine: Map<number, string>,
): {from: number; to: number} {
	let from = range.from;
	let to = range.to;
	for (const lineNumber of replacementByLine.keys()) {
		if (lineNumber < from) from = lineNumber;
		if (lineNumber > to) to = lineNumber;
	}
	return {from, to};
}

function makeNextOccurrence(
	original: TaskLine,
	completed: TaskLine,
	registry: StatusRegistry,
	settings: TaskLiteSettings,
	shift: Parameters<typeof shiftTaskDates>[1],
): TaskLine {
	const metadata = copyTaskMetadata(original.metadata);
	const completedOn = completed.metadata.dates.done ?? todayString();
	metadata.dates = shiftTaskDates(metadata.dates, shift, completedOn);
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
