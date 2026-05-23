import { TASK_SYMBOLS, type TaskLine } from "../model/format";

export interface TaskTodoSortableItem {
	path: string;
	lineNumber: number;
	depth: number;
	task: TaskLine;
	date: string | null;
	dateType: "due" | "scheduled" | "start" | null;
}

export function compareTaskTodoItems(left: TaskTodoSortableItem, right: TaskTodoSortableItem): number {
	return (
		compareNumber(priorityRank(left), priorityRank(right)) ||
		compareNumber(dateTypeRank(left), dateTypeRank(right)) ||
		compareString(left.date ?? "9999-12-31", right.date ?? "9999-12-31") ||
		compareNumber(left.depth, right.depth) ||
		compareString(left.path, right.path) ||
		compareNumber(left.lineNumber, right.lineNumber)
	);
}

function priorityRank(item: TaskTodoSortableItem): number {
	const priority = item.task.metadata.priority;
	if (priority === TASK_SYMBOLS.priority.highest) return 0;
	if (priority === TASK_SYMBOLS.priority.high) return 1;
	if (priority === TASK_SYMBOLS.priority.medium) return 2;
	if (priority === TASK_SYMBOLS.priority.low) return 4;
	if (priority === TASK_SYMBOLS.priority.lowest) return 5;
	return 3;
}

function dateTypeRank(item: TaskTodoSortableItem): number {
	if (item.dateType === "due") return 0;
	if (item.dateType === "scheduled") return 1;
	if (item.dateType === "start") return 2;
	return 3;
}

function compareNumber(left: number, right: number): number {
	return left - right;
}

function compareString(left: string, right: string): number {
	return left.localeCompare(right);
}
