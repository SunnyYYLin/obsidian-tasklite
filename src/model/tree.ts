import type { CachedMetadata, ListItemCache } from "obsidian";
import { parseTaskLine, listItemRegex, type TaskLine } from "./format";
import type { StatusRegistry } from "./status";

export interface TaskTreeNode {
	lineNumber: number;
	parentLine: number | null;
	parent: TaskTreeNode | null;
	children: TaskTreeNode[];
	original: string;
	indentation: string;
	listMarker: string;
	statusCharacter: string | null;
	description: string;
	task: TaskLine | null;
}

export interface TaskTree {
	nodes: TaskTreeNode[];
	byLine: Map<number, TaskTreeNode>;
}

export function buildTaskTree(lines: string[], metadata: CachedMetadata | null | undefined, registry: StatusRegistry): TaskTree {
	const byLine = new Map<number, TaskTreeNode>();
	const nodes: TaskTreeNode[] = [];
	const listItems = metadata?.listItems ?? inferListItems(lines);

	for (const item of listItems) {
		const lineNumber = item.position.start.line;
		const line = lines[lineNumber];
		if (line === undefined) continue;

		const match = line.match(listItemRegex);
		if (!match) continue;

		const statusCharacter = match[3] ?? null;
		const node: TaskTreeNode = {
			lineNumber,
			parentLine: typeof item.parent === "number" && item.parent >= 0 ? item.parent : null,
			parent: null,
			children: [],
			original: line,
			indentation: match[1] ?? "",
			listMarker: match[2] ?? "-",
			statusCharacter,
			description: (match[4] ?? "").trim(),
			task: statusCharacter === null ? null : parseTaskLine(line, registry.get(statusCharacter)),
		};
		nodes.push(node);
		byLine.set(lineNumber, node);
	}

	for (const node of nodes) {
		const parent = node.parentLine === null ? null : byLine.get(node.parentLine);
		if (parent) {
			node.parent = parent;
			parent.children.push(node);
		}
	}

	return {nodes, byLine};
}

export function getSubtreeNodes(root: TaskTreeNode): TaskTreeNode[] {
	const result: TaskTreeNode[] = [];
	const visit = (node: TaskTreeNode) => {
		result.push(node);
		for (const child of node.children) visit(child);
	};
	visit(root);
	return result.sort((a, b) => a.lineNumber - b.lineNumber);
}

export function getSubtreeLineRange(root: TaskTreeNode): {from: number; to: number} {
	const nodes = getSubtreeNodes(root);
	return {
		from: nodes[0]?.lineNumber ?? root.lineNumber,
		to: nodes[nodes.length - 1]?.lineNumber ?? root.lineNumber,
	};
}

function inferListItems(lines: string[]): ListItemCache[] {
	const stack: Array<{indent: number; line: number}> = [];
	const result: ListItemCache[] = [];
	lines.forEach((line, index) => {
		const match = line.match(listItemRegex);
		if (!match) return;
		const indent = (match[1] ?? "").replace(/\t/gu, "    ").length;
		while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) {
			stack.pop();
		}
		const parent = stack.length > 0 ? stack[stack.length - 1]!.line : -1;
		result.push({
			id: index.toString(),
			parent,
			task: match[3],
			position: {
				start: {line: index, col: 0, offset: 0},
				end: {line: index, col: line.length, offset: 0},
			},
		} as unknown as ListItemCache);
		stack.push({indent, line: index});
	});
	return result;
}
