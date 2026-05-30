import type { CachedMetadata } from "obsidian";
import { serializeTaskLine, type TaskLine } from "../model/format";
import { getSubtreeLineRange, getSubtreeNodes, buildTaskTree, type TaskTreeNode } from "../model/tree";
import { applyTaskStatus } from "../model/taskState";
import type { StatusConfiguration, StatusRegistry, StatusType } from "../model/status";
import type { TaskLiteSettings } from "../settings";
import { buildRecurringTaskOccurrence } from "./recurrenceOccurrence";

export interface ToggleResult {
	fromLine: number;
	toLine: number;
	replacement: string[];
	warning?: string;
}

interface TaskMutationContext {
	lines: string[];
	node: TaskTreeNode;
	changedTasks: Map<number, TaskLine>;
	replacementByLine: Map<number, string>;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
	unsupportedRecurrenceWarning: string;
}

interface TaskStatusMutationInput {
	lines: string[];
	lineNumber: number;
	metadata: CachedMetadata | null | undefined;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
}

type TaskBehavior = "finish" | "unfinish" | "cancel" | "uncancel";

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

	const targetStatus = registry.next(node.task.status);
	if (targetStatus.type === "DONE") return finishTaskAtLine({lines, lineNumber, metadata, registry, settings});
	if (targetStatus.type === "CANCELLED") return cancelTaskAtLine({lines, lineNumber, metadata, registry, settings});
	if (node.task.status.type === "DONE") return unfinishTaskAtLine({lines, lineNumber, metadata, registry, settings});
	if (node.task.status.type === "CANCELLED") return uncancelTaskAtLine({lines, lineNumber, metadata, registry, settings});
	return updateSingleTaskStatusAtLine({lines, lineNumber, metadata, registry, settings, status: targetStatus});
}

export function finishTaskAtLine(input: TaskStatusMutationInput): ToggleResult | null {
	return applyTaskBehaviorAtLine({...input, behavior: "finish"});
}

export function unfinishTaskAtLine(input: TaskStatusMutationInput): ToggleResult | null {
	return applyTaskBehaviorAtLine({...input, behavior: "unfinish"});
}

export function cancelTaskAtLine(input: TaskStatusMutationInput): ToggleResult | null {
	return applyTaskBehaviorAtLine({...input, behavior: "cancel"});
}

export function uncancelTaskAtLine(input: TaskStatusMutationInput): ToggleResult | null {
	return applyTaskBehaviorAtLine({...input, behavior: "uncancel"});
}

export function clickTaskCheckboxAtLine(input: TaskStatusMutationInput): ToggleResult | null {
	const tree = buildTaskTree(input.lines, input.metadata, input.registry);
	const node = tree.byLine.get(input.lineNumber);
	if (!node?.task) return node ? togglePlainCheckbox(node, input.registry) : null;
	if (node.task.status.type === "DONE") return unfinishTaskAtLine(input);
	if (node.task.status.type === "CANCELLED") return uncancelTaskAtLine(input);
	return finishTaskAtLine(input);
}

export function rightClickTaskCheckboxAtLine(input: TaskStatusMutationInput): ToggleResult | null {
	const tree = buildTaskTree(input.lines, input.metadata, input.registry);
	const node = tree.byLine.get(input.lineNumber);
	if (!node?.task) return null;
	if (node.task.status.type === "CANCELLED") return uncancelTaskAtLine(input);
	return cancelTaskAtLine(input);
}

function applyTaskBehaviorAtLine({
	lines,
	lineNumber,
	metadata,
	registry,
	settings,
	behavior,
}: {
	lines: string[];
	lineNumber: number;
	metadata: CachedMetadata | null | undefined;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
	behavior: TaskBehavior;
}): ToggleResult | null {
	const tree = buildTaskTree(lines, metadata, registry);
	const node = tree.byLine.get(lineNumber);
	if (!node?.task) return null;

	const changedTasks = new Map<number, TaskLine>();
	const replacementByLine = new Map<number, string>();
	if (shouldCascade(behavior, settings)) {
		applyBehaviorToSubtree(node, behavior, changedTasks, replacementByLine, registry, settings);
	} else {
		applyBehaviorToTarget(node, behavior, changedTasks, replacementByLine, registry, settings);
	}
	if (shouldPropagateToParent(behavior, settings)) {
		applyBehaviorToParents(node, behavior, changedTasks, replacementByLine, registry, settings);
	}
	if (changedTasks.size === 0) return null;

	return buildTaskMutationResult({
		lines,
		node,
		changedTasks,
		replacementByLine,
		registry,
		settings,
		unsupportedRecurrenceWarning: "TaskLite: unsupported recurrence rule; updated without creating the next copy.",
	});
}

function updateSingleTaskStatusAtLine({
	lines,
	lineNumber,
	metadata,
	registry,
	settings,
	status,
}: TaskStatusMutationInput & {status: StatusConfiguration}): ToggleResult | null {
	const tree = buildTaskTree(lines, metadata, registry);
	const node = tree.byLine.get(lineNumber);
	if (!node?.task) return null;
	if (node.task.status.symbol === status.symbol && !needsMissingStatusDate(node.task, status)) return null;

	const changedTask = applyTaskStatus(node.task, status, settings, {fillMissingStatusDate: true});
	const changedTasks = new Map<number, TaskLine>([[node.lineNumber, changedTask]]);
	const replacementByLine = new Map<number, string>([[node.lineNumber, serializeTaskLine(changedTask)]]);
	return buildTaskMutationResult({
		lines,
		node,
		changedTasks,
		replacementByLine,
		registry,
		settings,
		unsupportedRecurrenceWarning: "TaskLite: unsupported recurrence rule; toggled without creating the next copy.",
	});
}

function buildTaskMutationResult({
	lines,
	node,
	changedTasks,
	replacementByLine,
	registry,
	settings,
	unsupportedRecurrenceWarning,
}: TaskMutationContext): ToggleResult {
	const baseRange = getSubtreeLineRange(node);
	const recurringNode = findRecurringTerminatedNode(node, changedTasks);
	const recurringRange = recurringNode ? getSubtreeLineRange(recurringNode) : null;
	const replacementRange = getReplacementRange(recurringRange ?? baseRange, replacementByLine);
	const originalLines = lines
		.slice(replacementRange.from, replacementRange.to + 1)
		.map((line, index) => replacementByLine.get(replacementRange.from + index) ?? line);

	if (!recurringNode?.task) {
		return {fromLine: replacementRange.from, toLine: replacementRange.to, replacement: originalLines};
	}

	const completedTask = changedTasks.get(recurringNode.lineNumber);
	if (!completedTask) {
		return {fromLine: replacementRange.from, toLine: replacementRange.to, replacement: originalLines};
	}

	const occurrence = buildRecurringTaskOccurrence({
		lines,
		recurringNode,
		terminatedTask: completedTask,
		registry,
		settings,
		unsupportedWarning: unsupportedRecurrenceWarning,
	});
	if (!occurrence) {
		return {fromLine: replacementRange.from, toLine: replacementRange.to, replacement: originalLines};
	}
	const onDelete = recurringNode.task.metadata.onCompletion === "delete";

	if (occurrence.warning) {
		return {
			fromLine: replacementRange.from,
			toLine: replacementRange.to,
			replacement: originalLines,
			warning: occurrence.warning,
		};
	}
	if (occurrence.skippedBecauseExisting && !onDelete) {
		return {fromLine: replacementRange.from, toLine: replacementRange.to, replacement: originalLines};
	}

	if (onDelete) {
		return {
			fromLine: recurringRange!.from,
			toLine: recurringRange!.to,
			replacement: occurrence.skippedBecauseExisting ? [] : occurrence.nextLines,
		};
	}

	return {
		fromLine: replacementRange.from,
		toLine: replacementRange.to,
		replacement: [...occurrence.nextLines, ...originalLines],
	};
}

function needsMissingStatusDate(task: TaskLine, status: TaskLine["status"]): boolean {
	return (status.type === "DONE" && !task.metadata.dates.done) || (status.type === "CANCELLED" && !task.metadata.dates.cancelled);
}

function togglePlainCheckbox(node: TaskTreeNode, registry: StatusRegistry): ToggleResult | null {
	if (node.statusCharacter === null) return null;
	const current = registry.get(node.statusCharacter);
	const next = registry.next(current);
	const replacement = node.original.replace(/\[(.)\]/u, `[${next.symbol}]`);
	return {fromLine: node.lineNumber, toLine: node.lineNumber, replacement: [replacement]};
}

function applyBehaviorToSubtree(
	node: TaskTreeNode,
	behavior: TaskBehavior,
	changedTasks: Map<number, TaskLine>,
	replacementByLine: Map<number, string>,
	registry: StatusRegistry,
	settings: TaskLiteSettings,
): void {
	for (const current of getSubtreeNodes(node)) {
		if (!current.task) continue;
		const nextStatus = statusForSubtreeBehavior(current, behavior, registry, replacementByLine, settings);
		if (!nextStatus) continue;
		replaceTaskStatus(current, nextStatus, changedTasks, replacementByLine, settings);
	}
}

function applyBehaviorToTarget(
	node: TaskTreeNode,
	behavior: TaskBehavior,
	changedTasks: Map<number, TaskLine>,
	replacementByLine: Map<number, string>,
	registry: StatusRegistry,
	settings: TaskLiteSettings,
): void {
	if (!node.task) return;
	const nextStatus = statusForSubtreeBehavior(node, behavior, registry, replacementByLine, settings);
	if (!nextStatus) return;
	replaceTaskStatus(node, nextStatus, changedTasks, replacementByLine, settings);
}

function applyBehaviorToParents(
	node: TaskTreeNode,
	behavior: TaskBehavior,
	changedTasks: Map<number, TaskLine>,
	replacementByLine: Map<number, string>,
	registry: StatusRegistry,
	settings: TaskLiteSettings,
): void {
	let parent = node.parent;
	while (parent?.task) {
		const nextStatus = statusForParentBehavior(parent, behavior, replacementByLine, registry);
		if (!nextStatus) break;
		replaceTaskStatus(parent, nextStatus, changedTasks, replacementByLine, settings);
		parent = parent.parent;
	}
}

function statusForSubtreeBehavior(
	node: TaskTreeNode,
	behavior: TaskBehavior,
	registry: StatusRegistry,
	replacementByLine: Map<number, string>,
	settings: TaskLiteSettings,
): StatusConfiguration | null {
	const type = node.task!.status.type;
	if (behavior === "finish") return type === "CANCELLED" ? null : registry.get("x");
	if (behavior === "cancel") {
		if (type === "DONE") return null;
		if (settings.toggleBehavior.parentOnCancel && node.children.length > 0 && areNonCancelledChildrenDone(node, replacementByLine, registry)) return registry.get("x");
		return registry.get("-");
	}
	if (behavior === "unfinish") return registry.get(" ");
	return type === "CANCELLED" ? registry.get(" ") : null;
}

function statusForParentBehavior(
	parent: TaskTreeNode,
	behavior: TaskBehavior,
	replacementByLine: Map<number, string>,
	registry: StatusRegistry,
): StatusConfiguration | null {
	if (!parent.task) return null;
	if (behavior === "finish") {
		if (parent.task.status.type === "CANCELLED" || parent.task.status.type === "DONE") return null;
		return areAllTaskChildrenTerminated(parent, replacementByLine, registry) ? registry.get("x") : null;
	}
	if (behavior === "cancel") {
		if (parent.task.status.type === "DONE" || parent.task.status.type === "CANCELLED") return null;
		return areNonCancelledChildrenDone(parent, replacementByLine, registry) ? registry.get("x") : null;
	}
	if (behavior === "unfinish") {
		return parent.task.status.type === "DONE" || parent.task.status.type === "CANCELLED" ? registry.get(" ") : null;
	}
	return parent.task.status.type === "CANCELLED" ? registry.get(" ") : null;
}

function replaceTaskStatus(
	node: TaskTreeNode,
	status: StatusConfiguration,
	changedTasks: Map<number, TaskLine>,
	replacementByLine: Map<number, string>,
	settings: TaskLiteSettings,
): void {
	if (!node.task) return;
	const currentTask = changedTasks.get(node.lineNumber) ?? node.task;
	if (currentTask.status.symbol === status.symbol && !needsMissingStatusDate(currentTask, status)) return;
	const updatedTask = applyTaskStatus(currentTask, status, settings, {fillMissingStatusDate: true});
	changedTasks.set(node.lineNumber, updatedTask);
	replacementByLine.set(node.lineNumber, serializeTaskLine(updatedTask));
}

function findRecurringTerminatedNode(node: TaskTreeNode, changedTasks: Map<number, TaskLine>): TaskTreeNode | null {
	let current: TaskTreeNode | null = node;
	while (current) {
		const changedTask = changedTasks.get(current.lineNumber);
		if (current.task?.metadata.recurrence && isTerminalStatus(changedTask?.status.type) && !isTerminalStatus(current.task.status.type)) {
			return current;
		}
		current = current.parent;
	}
	return null;
}

function areAllTaskChildrenTerminated(parent: TaskTreeNode, replacementByLine: Map<number, string>, registry: StatusRegistry): boolean {
	const taskChildren = parent.children.filter((child) => child.task);
	if (taskChildren.length === 0) return false;
	return taskChildren.every((child) => {
		if (!child.task) return false;
		const replacement = replacementByLine.get(child.lineNumber);
		if (!replacement) return isTerminalStatus(child.task.status.type);
		const statusSymbol = replacement.match(/\[(.)\]/u)?.[1] ?? child.task.status.symbol;
		return isTerminalStatus(registry.get(statusSymbol).type);
	});
}

function isTerminalStatus(type: StatusType | undefined): boolean {
	return type === "DONE" || type === "CANCELLED";
}

function shouldCascade(behavior: TaskBehavior, settings: TaskLiteSettings): boolean {
	if (behavior === "finish") return settings.toggleBehavior.cascadeFinish;
	if (behavior === "cancel") return settings.toggleBehavior.cascadeCancel;
	if (behavior === "unfinish") return settings.toggleBehavior.cascadeUnfinish;
	return settings.toggleBehavior.cascadeUncancel;
}

function shouldPropagateToParent(behavior: TaskBehavior, settings: TaskLiteSettings): boolean {
	if (behavior === "finish") return settings.toggleBehavior.parentOnFinish;
	if (behavior === "cancel") return settings.toggleBehavior.parentOnCancel;
	if (behavior === "unfinish") return settings.toggleBehavior.parentOnUnfinish;
	return settings.toggleBehavior.parentOnUncancel;
}

function areNonCancelledChildrenDone(parent: TaskTreeNode, replacementByLine: Map<number, string>, registry: StatusRegistry): boolean {
	const taskChildren = parent.children.filter((child) => child.task);
	for (const child of taskChildren) {
		if (!child.task) continue;
		const replacement = replacementByLine.get(child.lineNumber);
		const statusSymbol = replacement ? (replacement.match(/\[(.)\]/u)?.[1] ?? child.task.status.symbol) : child.task.status.symbol;
		const statusType = registry.get(statusSymbol).type;
		if (statusType === "CANCELLED") continue;
		if (statusType !== "DONE") return false;
	}
	return true;
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
