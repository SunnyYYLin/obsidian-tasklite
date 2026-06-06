import type { App, CachedMetadata } from "obsidian";
import { serializeTaskLine, copyTaskData, type TaskLine, type TaskData } from "../model/format";
import { getSubtreeLineRange, getSubtreeNodes, buildTaskTree, taskDepth, type TaskTreeNode } from "../model/tree";
import { applyTaskStatus } from "../model/taskState";
import type { StatusConfiguration, StatusRegistry, StatusType } from "../model/status";
import type { TaskLiteSettings } from "../settings";
import { buildRecurringTaskOccurrence } from "./recurrenceOccurrence";
import { getVaultIndentConfig } from "./editorUtils";

export interface ToggleResult {
	fromLine: number;
	toLine: number;
	replacement: string[];
	warning?: string;
}

interface TaskMutationContext {
	lines: string[];
	node: TaskTreeNode;
	changedTasks: Map<number, TaskData>;
	replacementByLine: Map<number, string>;
	app?: App;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
	unsupportedRecurrenceWarning: string;
}

interface TaskStatusMutationInput {
	lines: string[];
	lineNumber: number;
	metadata: CachedMetadata | null | undefined;
	app?: App;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
}

type TaskBehavior = "finish" | "unfinish" | "cancel" | "uncancel";

export function getIndentPrefix(depth: number, app?: App, lines?: string[]): string {
	if (depth <= 0) return "";

	// 1. Try to read from app vault config
	if (app) {
		const { useTab, tabSize } = getVaultIndentConfig(app);
		// getVaultIndentConfig returns defaults when vault.config is absent;
		// only trust it when vault.config actually exists on the vault object.
		const hasConfig = Boolean(
			(app.vault as unknown as { config?: unknown } | undefined)?.config,
		);
		if (hasConfig) {
			const oneLevelIndent = useTab ? "\t" : " ".repeat(tabSize);
			return oneLevelIndent.repeat(depth);
		}
	}

	// 2. Fallback: detect indentation from document content (useful in tests and mixed vaults)
	if (lines && lines.length > 0) {
		for (const line of lines) {
			const match = line.match(/^([\s\t]+)/);
			if (match && match[1]) {
				const firstIndent = match[1];
				if (firstIndent.startsWith(" ")) {
					return firstIndent.repeat(depth);
				} else if (firstIndent.startsWith("\t")) {
					return "\t".repeat(depth);
				}
			}
		}
	}

	// 3. Absolute fallback: default Obsidian settings (use tab)
	return "\t".repeat(depth);
}

export function toggleTaskAtLine({
	lines,
	lineNumber,
	metadata,
	app,
	registry,
	settings,
}: {
	lines: string[];
	lineNumber: number;
	metadata: CachedMetadata | null | undefined;
	app?: App;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
}): ToggleResult | null {
	const tree = buildTaskTree(lines, metadata, registry);
	const node = tree.byLine.get(lineNumber);
	if (!node) return null;

	if (!node.task) {
		return togglePlainCheckbox(node, registry);
	}

	const symbol = registry.getByType(node.task.data.status).symbol;
	const targetStatus = registry.next(registry.get(symbol));
	return changeTaskStatusAtLine({
		lines,
		lineNumber,
		metadata,
		app,
		registry,
		settings,
		targetStatusSymbol: targetStatus.symbol,
	});
}

export function changeTaskStatusAtLine(
	input: TaskStatusMutationInput & { targetStatusSymbol: string }
): ToggleResult | null {
	const tree = buildTaskTree(input.lines, input.metadata, input.registry);
	const node = tree.byLine.get(input.lineNumber);
	if (!node) return null;

	if (!node.task) {
		if (node.statusCharacter === null) return null;
		const nextSymbol = input.targetStatusSymbol;
		const replacement = node.original.replace(/\[(.)\]/u, `[${nextSymbol}]`);
		return {fromLine: node.lineNumber, toLine: node.lineNumber, replacement: [replacement]};
	}

	const targetStatus = input.registry.get(input.targetStatusSymbol);
	if (node.task.data.status === targetStatus.type && !needsMissingStatusDate(node.task.data, targetStatus)) {
		return null;
	}

	if (targetStatus.type === "DONE") {
		return applyTaskBehaviorAtLine({...input, behavior: "finish"});
	}
	if (targetStatus.type === "CANCELLED") {
		return applyTaskBehaviorAtLine({...input, behavior: "cancel"});
	}
	if (targetStatus.type === "TODO") {
		if (node.task.data.status === "CANCELLED") {
			return applyTaskBehaviorAtLine({...input, behavior: "uncancel"});
		}
		return applyTaskBehaviorAtLine({...input, behavior: "unfinish"});
	}

	return updateSingleTaskStatusAtLine({...input, status: targetStatus});
}

export function finishTaskAtLine(input: TaskStatusMutationInput): ToggleResult | null {
	return changeTaskStatusAtLine({...input, targetStatusSymbol: "x"});
}

export function unfinishTaskAtLine(input: TaskStatusMutationInput): ToggleResult | null {
	return changeTaskStatusAtLine({...input, targetStatusSymbol: " "});
}

export function cancelTaskAtLine(input: TaskStatusMutationInput): ToggleResult | null {
	return changeTaskStatusAtLine({...input, targetStatusSymbol: "-"});
}

export function uncancelTaskAtLine(input: TaskStatusMutationInput): ToggleResult | null {
	return changeTaskStatusAtLine({...input, targetStatusSymbol: " "});
}

export function clickTaskCheckboxAtLine(input: TaskStatusMutationInput): ToggleResult | null {
	const tree = buildTaskTree(input.lines, input.metadata, input.registry);
	const node = tree.byLine.get(input.lineNumber);
	if (!node?.task) return node ? togglePlainCheckbox(node, input.registry) : null;
	if (node.task.data.status === "DONE") return unfinishTaskAtLine(input);
	if (node.task.data.status === "CANCELLED") return uncancelTaskAtLine(input);
	return finishTaskAtLine(input);
}

export function rightClickTaskCheckboxAtLine(input: TaskStatusMutationInput): ToggleResult | null {
	const tree = buildTaskTree(input.lines, input.metadata, input.registry);
	const node = tree.byLine.get(input.lineNumber);
	if (!node?.task) return null;
	if (node.task.data.status === "CANCELLED") return uncancelTaskAtLine(input);
	return cancelTaskAtLine(input);
}

function applyTaskBehaviorAtLine({
	lines,
	lineNumber,
	metadata,
	app,
	registry,
	settings,
	behavior,
}: {
	lines: string[];
	lineNumber: number;
	metadata: CachedMetadata | null | undefined;
	app?: App;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
	behavior: TaskBehavior;
}): ToggleResult | null {
	const tree = buildTaskTree(lines, metadata, registry);
	const node = tree.byLine.get(lineNumber);
	if (!node?.task) return null;

	const changedTasks = new Map<number, TaskData>();
	const replacementByLine = new Map<number, string>();
	if (shouldCascade(behavior, settings)) {
		applyBehaviorToSubtree(node, behavior, changedTasks, replacementByLine, registry, settings, app, lines);
	} else {
		applyBehaviorToTarget(node, behavior, changedTasks, replacementByLine, registry, settings, app, lines);
	}
	if (shouldPropagateToParent(behavior, settings)) {
		applyBehaviorToParents(node, behavior, changedTasks, replacementByLine, registry, settings, app, lines);
	}
	if (changedTasks.size === 0) return null;

	return buildTaskMutationResult({
		lines,
		node,
		changedTasks,
		replacementByLine,
		app,
		registry,
		settings,
		unsupportedRecurrenceWarning: "TaskLite: unsupported recurrence rule; updated without creating the next copy.",
	});
}

function updateSingleTaskStatusAtLine({
	lines,
	lineNumber,
	metadata,
	app,
	registry,
	settings,
	status,
}: TaskStatusMutationInput & {status: StatusConfiguration}): ToggleResult | null {
	const tree = buildTaskTree(lines, metadata, registry);
	const node = tree.byLine.get(lineNumber);
	if (!node?.task) return null;
	if (node.task.data.status === status.type && !needsMissingStatusDate(node.task.data, status)) return null;

	const changedTask = applyTaskStatus(node.task.data, status.type, settings, {fillMissingStatusDate: true});
	const changedTasks = new Map<number, TaskData>([[node.lineNumber, changedTask]]);
	const depth = taskDepth(node);
	const indent = getIndentPrefix(depth, app, lines);
	const replacementByLine = new Map<number, string>([[node.lineNumber, serializeTaskLine({...node.task, data: changedTask}, indent, registry)]]);
	return buildTaskMutationResult({
		lines,
		node,
		changedTasks,
		replacementByLine,
		app,
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
	app,
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
		const completedNode = findTerminatedNode(node, changedTasks);
		if (completedNode?.task?.data.onCompletion === "delete") {
			const deleteRange = getSubtreeLineRange(completedNode);
			return {fromLine: deleteRange.from, toLine: deleteRange.to, replacement: []};
		}
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
		app,
		registry,
		settings,
		unsupportedWarning: unsupportedRecurrenceWarning,
	});
	if (!occurrence) {
		return {fromLine: replacementRange.from, toLine: replacementRange.to, replacement: originalLines};
	}
	const onDelete = recurringNode.task.data.onCompletion === "delete";

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

function needsMissingStatusDate(task: TaskData, status: { symbol: string; type: StatusType }): boolean {
	return (status.type === "DONE" && !task.dates.done) || (status.type === "CANCELLED" && !task.dates.cancelled);
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
	changedTasks: Map<number, TaskData>,
	replacementByLine: Map<number, string>,
	registry: StatusRegistry,
	settings: TaskLiteSettings,
	app?: App,
	lines?: string[],
): void {
	for (const current of getSubtreeNodes(node)) {
		if (!current.task) continue;
		const nextStatus = statusForSubtreeBehavior(current, behavior, registry, changedTasks, settings);
		if (!nextStatus) continue;
		replaceTaskStatus(current, nextStatus, changedTasks, replacementByLine, settings, app, registry, lines);
	}
}

function applyBehaviorToTarget(
	node: TaskTreeNode,
	behavior: TaskBehavior,
	changedTasks: Map<number, TaskData>,
	replacementByLine: Map<number, string>,
	registry: StatusRegistry,
	settings: TaskLiteSettings,
	app?: App,
	lines?: string[],
): void {
	if (!node.task) return;
	const nextStatus = statusForSubtreeBehavior(node, behavior, registry, changedTasks, settings);
	if (!nextStatus) return;
	replaceTaskStatus(node, nextStatus, changedTasks, replacementByLine, settings, app, registry, lines);
}

function applyBehaviorToParents(
	node: TaskTreeNode,
	behavior: TaskBehavior,
	changedTasks: Map<number, TaskData>,
	replacementByLine: Map<number, string>,
	registry: StatusRegistry,
	settings: TaskLiteSettings,
	app?: App,
	lines?: string[],
): void {
	let parent = node.parent;
	while (parent?.task) {
		const nextStatus = statusForParentBehavior(parent, behavior, changedTasks, registry);
		if (!nextStatus) break;
		replaceTaskStatus(parent, nextStatus, changedTasks, replacementByLine, settings, app, registry, lines);
		parent = parent.parent;
	}
}

function statusForSubtreeBehavior(
	node: TaskTreeNode,
	behavior: TaskBehavior,
	registry: StatusRegistry,
	changedTasks: Map<number, TaskData>,
	settings: TaskLiteSettings,
): StatusConfiguration | null {
	const type = node.task!.data.status;
	if (behavior === "finish") return type === "CANCELLED" ? null : registry.get("x");
	if (behavior === "cancel") {
		if (type === "DONE") return null;
		if (settings.toggleBehavior.parentOnCancel && node.children.length > 0 && areNonCancelledChildrenDone(node, changedTasks)) return registry.get("x");
		return registry.get("-");
	}
	if (behavior === "unfinish") return registry.get(" ");
	return type === "CANCELLED" ? registry.get(" ") : null;
}

function statusForParentBehavior(
	parent: TaskTreeNode,
	behavior: TaskBehavior,
	changedTasks: Map<number, TaskData>,
	registry: StatusRegistry,
): StatusConfiguration | null {
	if (!parent.task) return null;
	const type = parent.task.data.status;
	if (behavior === "finish") {
		if (type === "CANCELLED" || type === "DONE") return null;
		return areAllTaskChildrenTerminated(parent, changedTasks) ? registry.get("x") : null;
	}
	if (behavior === "cancel") {
		if (type === "DONE" || type === "CANCELLED") return null;
		return areNonCancelledChildrenDone(parent, changedTasks) ? registry.get("x") : null;
	}
	if (behavior === "unfinish") {
		return type === "DONE" || type === "CANCELLED" ? registry.get(" ") : null;
	}
	return type === "CANCELLED" ? registry.get(" ") : null;
}

function replaceTaskStatus(
	node: TaskTreeNode,
	status: StatusConfiguration,
	changedTasks: Map<number, TaskData>,
	replacementByLine: Map<number, string>,
	settings: TaskLiteSettings,
	app: App | undefined,
	registry: StatusRegistry,
	lines: string[] | undefined,
): void {
	if (!node.task) return;
	const currentTask = changedTasks.get(node.lineNumber) ?? node.task.data;
	if (currentTask.status === status.type && !needsMissingStatusDate(currentTask, status)) return;
	const updatedTask = applyTaskStatus(currentTask, status.type, settings, {fillMissingStatusDate: true});
	changedTasks.set(node.lineNumber, updatedTask);
	const depth = taskDepth(node);
	const indent = getIndentPrefix(depth, app, lines);
	replacementByLine.set(node.lineNumber, serializeTaskLine({...node.task, data: updatedTask}, indent, registry));
}

function findRecurringTerminatedNode(node: TaskTreeNode, changedTasks: Map<number, TaskData>): TaskTreeNode | null {
	let current: TaskTreeNode | null = node;
	while (current) {
		const changedTask = changedTasks.get(current.lineNumber);
		const statusType = changedTask ? changedTask.status : current.task?.data.status;
		if (current.task?.data.recurrence && isTerminalStatus(statusType) && !isTerminalStatus(current.task.data.status)) {
			return current;
		}
		current = current.parent;
	}
	return null;
}

function findTerminatedNode(node: TaskTreeNode, changedTasks: Map<number, TaskData>): TaskTreeNode | null {
	const changedTask = changedTasks.get(node.lineNumber);
	if (node.task && isTerminalStatus(changedTask?.status) && !isTerminalStatus(node.task.data.status)) {
		return node;
	}
	return null;
}

function areAllTaskChildrenTerminated(parent: TaskTreeNode, changedTasks: Map<number, TaskData>): boolean {
	const taskChildren = parent.children.filter((child) => child.task);
	if (taskChildren.length === 0) return false;
	return taskChildren.every((child) => {
		if (!child.task) return false;
		const changedTask = changedTasks.get(child.lineNumber);
		const statusType = changedTask ? changedTask.status : child.task.data.status;
		return isTerminalStatus(statusType);
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

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function shouldPropagateToParent(behavior: TaskBehavior, settings: TaskLiteSettings): boolean {
	if (behavior === "finish") return settings.toggleBehavior.parentOnFinish;
	if (behavior === "cancel") return settings.toggleBehavior.parentOnCancel;
	if (behavior === "unfinish") return settings.toggleBehavior.parentOnUnfinish;
	return settings.toggleBehavior.parentOnUncancel;
}

function areNonCancelledChildrenDone(parent: TaskTreeNode, changedTasks: Map<number, TaskData>): boolean {
	const taskChildren = parent.children.filter((child) => child.task);
	for (const child of taskChildren) {
		if (!child.task) continue;
		const changedTask = changedTasks.get(child.lineNumber);
		const statusType = changedTask ? changedTask.status : child.task.data.status;
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
