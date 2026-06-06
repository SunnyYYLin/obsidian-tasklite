/**
 * toggleMutation.ts
 *
 * Internal helpers for task-status mutation:
 *   - MutationCtx: bundles the 6 shared parameters that were previously threaded
 *     individually through every internal function (fixes the parameter-explosion
 *     design flaw).
 *   - Behavior dispatch: applyBehavior*, statusFor*, shouldCascade, etc.
 *   - Line-replacement building: replaceTaskStatus, buildTaskMutationResult.
 *
 * Nothing in this file is exported as part of the public API; consumers should
 * import from toggle.ts instead.
 */

import type { App } from "obsidian";
import { serializeTaskLine, copyTaskData, type TaskData } from "../model/format";
import { getSubtreeLineRange, getSubtreeNodes, taskDepth, type TaskTreeNode } from "../model/tree";
import { applyTaskStatus } from "../model/taskState";
import type { StatusConfiguration, StatusRegistry, StatusType } from "../model/status";
import type { TaskLiteSettings } from "../settings";
import { buildRecurringTaskOccurrence } from "./recurrenceOccurrence";
import { getIndentPrefix } from "./toggle";
import type { ToggleResult } from "./toggle";

// ---------------------------------------------------------------------------
// Shared context object (replaces the 6-arg parameter lists)
// ---------------------------------------------------------------------------

/** Bundles the environment shared across every mutation helper. */
export interface MutationCtx {
	/** Current line content of the document. */
	lines: string[];
	/** Obsidian app instance (optional; absent in tests and single-line API calls). */
	app?: App;
	/** Status registry used to resolve symbols ↔ types. */
	registry: StatusRegistry;
	/** Plugin settings governing cascade / parent-propagation behaviour. */
	settings: TaskLiteSettings;
}

// ---------------------------------------------------------------------------
// Public types re-exported for callers inside this module
// ---------------------------------------------------------------------------

export type TaskBehavior = "finish" | "unfinish" | "cancel" | "uncancel";

export interface TaskMutationContext extends MutationCtx {
	node: TaskTreeNode;
	changedTasks: Map<number, TaskData>;
	replacementByLine: Map<number, string>;
	unsupportedRecurrenceWarning: string;
}

// ---------------------------------------------------------------------------
// Behaviour dispatch
// ---------------------------------------------------------------------------

/** Apply behavior to `node` and its entire subtree, populating the two maps. */
export function applyBehaviorToSubtree(
	node: TaskTreeNode,
	behavior: TaskBehavior,
	changedTasks: Map<number, TaskData>,
	replacementByLine: Map<number, string>,
	ctx: MutationCtx,
): void {
	for (const current of getSubtreeNodes(node)) {
		if (!current.task) continue;
		const nextStatus = statusForSubtreeBehavior(current, behavior, ctx.registry, changedTasks, ctx.settings);
		if (!nextStatus) continue;
		replaceTaskStatus(current, nextStatus, changedTasks, replacementByLine, ctx);
	}
}

/** Apply behavior to `node` only (no cascade), populating the two maps. */
export function applyBehaviorToTarget(
	node: TaskTreeNode,
	behavior: TaskBehavior,
	changedTasks: Map<number, TaskData>,
	replacementByLine: Map<number, string>,
	ctx: MutationCtx,
): void {
	if (!node.task) return;
	const nextStatus = statusForSubtreeBehavior(node, behavior, ctx.registry, changedTasks, ctx.settings);
	if (!nextStatus) return;
	replaceTaskStatus(node, nextStatus, changedTasks, replacementByLine, ctx);
}

/** Walk ancestors and propagate behavior, populating the two maps. */
export function applyBehaviorToParents(
	node: TaskTreeNode,
	behavior: TaskBehavior,
	changedTasks: Map<number, TaskData>,
	replacementByLine: Map<number, string>,
	ctx: MutationCtx,
): void {
	let parent = node.parent;
	while (parent?.task) {
		const nextStatus = statusForParentBehavior(parent, behavior, changedTasks, ctx.registry);
		if (!nextStatus) break;
		replaceTaskStatus(parent, nextStatus, changedTasks, replacementByLine, ctx);
		parent = parent.parent;
	}
}

// ---------------------------------------------------------------------------
// Status resolution helpers
// ---------------------------------------------------------------------------

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
		if (settings.toggleBehavior.parentOnCancel && node.children.length > 0 && areNonCancelledChildrenDone(node, changedTasks))
			return registry.get("x");
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

// ---------------------------------------------------------------------------
// Cascade / propagation settings
// ---------------------------------------------------------------------------

export function shouldCascade(behavior: TaskBehavior, settings: TaskLiteSettings): boolean {
	if (behavior === "finish") return settings.toggleBehavior.cascadeFinish;
	if (behavior === "cancel") return settings.toggleBehavior.cascadeCancel;
	if (behavior === "unfinish") return settings.toggleBehavior.cascadeUnfinish;
	return settings.toggleBehavior.cascadeUncancel;
}

export function shouldPropagateToParent(behavior: TaskBehavior, settings: TaskLiteSettings): boolean {
	if (behavior === "finish") return settings.toggleBehavior.parentOnFinish;
	if (behavior === "cancel") return settings.toggleBehavior.parentOnCancel;
	if (behavior === "unfinish") return settings.toggleBehavior.parentOnUnfinish;
	return settings.toggleBehavior.parentOnUncancel;
}

// ---------------------------------------------------------------------------
// Line-replacement helpers
// ---------------------------------------------------------------------------

/** Compute the updated TaskData + serialized line for one node. */
export function replaceTaskStatus(
	node: TaskTreeNode,
	status: StatusConfiguration,
	changedTasks: Map<number, TaskData>,
	replacementByLine: Map<number, string>,
	ctx: MutationCtx,
): void {
	if (!node.task) return;
	const currentTask = changedTasks.get(node.lineNumber) ?? node.task.data;
	if (currentTask.status === status.type && !needsMissingStatusDate(currentTask, status)) return;
	const updatedTask = applyTaskStatus(currentTask, status.type, ctx.settings, {fillMissingStatusDate: true});
	changedTasks.set(node.lineNumber, updatedTask);
	const depth = taskDepth(node);
	const indent = getIndentPrefix(depth, ctx.app, ctx.lines);
	replacementByLine.set(node.lineNumber, serializeTaskLine({...node.task, data: updatedTask}, indent, ctx.registry));
}

export function needsMissingStatusDate(task: TaskData, status: {type: StatusType}): boolean {
	return (status.type === "DONE" && !task.dates.done) || (status.type === "CANCELLED" && !task.dates.cancelled);
}

export function getReplacementRange(
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

// ---------------------------------------------------------------------------
// Result assembly
// ---------------------------------------------------------------------------

/** Assemble the final ToggleResult, handling recurrence and onCompletion. */
export function buildTaskMutationResult(mutCtx: TaskMutationContext): ToggleResult {
	const {lines, node, changedTasks, replacementByLine, app, registry, settings, unsupportedRecurrenceWarning} = mutCtx;
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

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// TaskData copy helper (re-exported so toggle.ts doesn't need format import)
// ---------------------------------------------------------------------------
export { copyTaskData };
