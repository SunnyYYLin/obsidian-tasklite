/**
 * toggle.ts — Public API for task-status mutations.
 *
 * Each exported function accepts the raw document lines + metadata and returns
 * a ToggleResult describing exactly which lines to replace (or null when there
 * is nothing to do).  Internal behaviour dispatch and line-building logic lives
 * in toggleMutation.ts.
 */

import type { App, CachedMetadata } from "obsidian";
import { serializeTaskLine, type TaskData } from "../model/format";
import { getSubtreeLineRange, buildTaskTree, taskDepth, type TaskTreeNode } from "../model/tree";
import { applyTaskStatus } from "../model/taskState";
import type { StatusConfiguration, StatusRegistry } from "../model/status";
import type { TaskLiteSettings } from "../settings";
import { getVaultIndentConfig, hasVaultConfig } from "./editorUtils";
import {
	type MutationCtx,
	type TaskBehavior,
	type TaskMutationContext,
	applyBehaviorToSubtree,
	applyBehaviorToTarget,
	applyBehaviorToParents,
	shouldCascade,
	shouldPropagateToParent,
	buildTaskMutationResult,
	needsMissingStatusDate,
	replaceTaskStatus,
} from "./toggleMutation";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ToggleResult {
	fromLine: number;
	toLine: number;
	replacement: string[];
	warning?: string;
}

export interface TaskStatusMutationInput {
	lines: string[];
	lineNumber: number;
	metadata: CachedMetadata | null | undefined;
	app?: App;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
}

// ---------------------------------------------------------------------------
// Indentation helper (used by toggleMutation.ts and external callers)
// ---------------------------------------------------------------------------

export function getIndentPrefix(depth: number, app?: App, lines?: string[]): string {
	if (depth <= 0) return "";

	// 1. Try to read from app vault config
	if (app && hasVaultConfig(app)) {
		const {useTab, tabSize} = getVaultIndentConfig(app);
		const oneLevelIndent = useTab ? "\t" : " ".repeat(tabSize);
		return oneLevelIndent.repeat(depth);
	}

	// 2. Fallback: detect indentation from document content (useful in tests)
	if (lines && lines.length > 0) {
		for (const line of lines) {
			const match = line.match(/^([\s\t]+)/);
			if (match && match[1]) {
				const firstIndent = match[1];
				if (firstIndent.startsWith(" ")) return firstIndent.repeat(depth);
				if (firstIndent.startsWith("\t")) return "\t".repeat(depth);
			}
		}
	}

	// 3. Absolute fallback: default Obsidian settings (use tab)
	return "\t".repeat(depth);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function toggleTaskAtLine({
	lines,
	lineNumber,
	metadata,
	app,
	registry,
	settings,
}: TaskStatusMutationInput): ToggleResult | null {
	const tree = buildTaskTree(lines, metadata, registry);
	const node = tree.byLine.get(lineNumber);
	if (!node) return null;
	if (!node.task) return togglePlainCheckbox(node, registry);

	const symbol = registry.getByType(node.task.data.status).symbol;
	const targetStatus = registry.next(registry.get(symbol));
	return changeTaskStatusWithTree(tree, {lines, lineNumber, metadata, app, registry, settings, targetStatusSymbol: targetStatus.symbol}, node);
}

export function changeTaskStatusAtLine(
	input: TaskStatusMutationInput & {targetStatusSymbol: string},
): ToggleResult | null {
	const tree = buildTaskTree(input.lines, input.metadata, input.registry);
	const node = tree.byLine.get(input.lineNumber);
	return changeTaskStatusWithTree(tree, input, node);
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
	const sym = node.task.data.status === "DONE" ? " " : node.task.data.status === "CANCELLED" ? " " : "x";
	return changeTaskStatusWithTree(tree, {...input, targetStatusSymbol: sym}, node);
}

export function rightClickTaskCheckboxAtLine(input: TaskStatusMutationInput): ToggleResult | null {
	const tree = buildTaskTree(input.lines, input.metadata, input.registry);
	const node = tree.byLine.get(input.lineNumber);
	if (!node?.task) return null;
	const sym = node.task.data.status === "CANCELLED" ? " " : "-";
	return changeTaskStatusWithTree(tree, {...input, targetStatusSymbol: sym}, node);
}

// ---------------------------------------------------------------------------
// Internal helpers (not exported)
// ---------------------------------------------------------------------------

export function getUnfinishedDependencies(
	dependsOn: string | null,
	app?: App
): string[] {
	if (!dependsOn || !app) return [];
	const depIds = dependsOn
		.split(",")
		.map((id) => id.trim())
		.filter(Boolean);
	if (depIds.length === 0) return [];

	const plugin = (app as any).plugins?.plugins?.["obsidian-tasklite"];
	const documentStore = plugin?.documentStore;
	if (!documentStore) return [];

	const records = documentStore.listCachedRecords();
	const unfinished = new Set<string>();

	for (const r of records) {
		if (r.task.id && depIds.includes(r.task.id)) {
			const status = r.task.status; // status type
			if (status !== "DONE" && status !== "CANCELLED") {
				unfinished.add(r.task.id);
			}
		}
	}
	return Array.from(unfinished);
}

/** Core dispatch: operates on an already-built tree (avoids redundant rebuilds). */
function changeTaskStatusWithTree(
	tree: ReturnType<typeof buildTaskTree>,
	input: TaskStatusMutationInput & {targetStatusSymbol: string},
	node: TaskTreeNode | undefined,
): ToggleResult | null {
	if (!node) return null;

	if (!node.task) {
		if (node.statusCharacter === null) return null;
		const replacement = node.original.replace(/\[(.)\]/u, `[${input.targetStatusSymbol}]`);
		return {fromLine: node.lineNumber, toLine: node.lineNumber, replacement: [replacement]};
	}

	const targetStatus = input.registry.get(input.targetStatusSymbol);
	if (node.task.data.status === targetStatus.type && !needsMissingStatusDate(node.task.data, targetStatus)) {
		return null;
	}

	const ctx: MutationCtx = {lines: input.lines, app: input.app, registry: input.registry, settings: input.settings};

	if (targetStatus.type === "DONE") {
		const unfinished = getUnfinishedDependencies(node.task.data.dependsOn, input.app);
		if (unfinished.length > 0) {
			return {
				fromLine: node.lineNumber,
				toLine: node.lineNumber,
				replacement: [node.original],
				warning: `Task is blocked by unfinished dependencies: ${unfinished.join(", ")}`,
			};
		}
		return applyBehaviorWithNode(ctx, "finish", node, tree);
	}
	if (targetStatus.type === "CANCELLED") return applyBehaviorWithNode(ctx, "cancel", node, tree);
	if (targetStatus.type === "TODO") {
		const behavior = node.task.data.status === "CANCELLED" ? "uncancel" : "unfinish";
		return applyBehaviorWithNode(ctx, behavior, node, tree);
	}

	return updateSingleStatus(ctx, targetStatus, node);
}

function applyBehaviorWithNode(
	ctx: MutationCtx,
	behavior: TaskBehavior,
	node: TaskTreeNode,
	_tree: ReturnType<typeof buildTaskTree>,
): ToggleResult | null {
	if (!node.task) return null;
	const changedTasks = new Map<number, TaskData>();
	const replacementByLine = new Map<number, string>();

	if (shouldCascade(behavior, ctx.settings)) {
		applyBehaviorToSubtree(node, behavior, changedTasks, replacementByLine, ctx);
	} else {
		applyBehaviorToTarget(node, behavior, changedTasks, replacementByLine, ctx);
	}
	if (shouldPropagateToParent(behavior, ctx.settings)) {
		applyBehaviorToParents(node, behavior, changedTasks, replacementByLine, ctx);
	}
	if (changedTasks.size === 0) return null;

	const mutCtx: TaskMutationContext = {
		...ctx,
		node,
		changedTasks,
		replacementByLine,
		unsupportedRecurrenceWarning: "TaskLite: unsupported recurrence rule; updated without creating the next copy.",
	};
	return buildTaskMutationResult(mutCtx);
}

function updateSingleStatus(
	ctx: MutationCtx,
	status: StatusConfiguration,
	node: TaskTreeNode,
): ToggleResult | null {
	if (!node.task) return null;
	if (node.task.data.status === status.type && !needsMissingStatusDate(node.task.data, status)) return null;

	const changedTask = applyTaskStatus(node.task.data, status.type, ctx.settings, {fillMissingStatusDate: true});
	const changedTasks = new Map<number, TaskData>([[node.lineNumber, changedTask]]);
	const indent = getIndentPrefix(taskDepth(node), ctx.app, ctx.lines);
	const replacementByLine = new Map<number, string>([
		[node.lineNumber, serializeTaskLine({...node.task, data: changedTask}, indent, ctx.registry)],
	]);

	const mutCtx: TaskMutationContext = {
		...ctx,
		node,
		changedTasks,
		replacementByLine,
		unsupportedRecurrenceWarning: "TaskLite: unsupported recurrence rule; toggled without creating the next copy.",
	};
	return buildTaskMutationResult(mutCtx);
}

function togglePlainCheckbox(node: TaskTreeNode, registry: StatusRegistry): ToggleResult | null {
	if (node.statusCharacter === null) return null;
	const current = registry.get(node.statusCharacter);
	const next = registry.next(current);
	const replacement = node.original.replace(/\[(.)\]/u, `[${next.symbol}]`);
	return {fromLine: node.lineNumber, toLine: node.lineNumber, replacement: [replacement]};
}

// Re-export so external callers that reference these by name continue to work
export {replaceTaskStatus, getSubtreeLineRange};
