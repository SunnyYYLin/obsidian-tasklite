import { finishTaskAtLine, cancelTaskAtLine } from "./toggle";
import { buildTaskTree } from "../model/tree";
import { taskIdentityKey } from "../model/taskIdentity";
import type { StatusRegistry } from "../model/status";
import type { TaskLiteSettings } from "../settings";

export function reconcileExternalTaskCompletion({
	before,
	after,
	registry,
	settings,
}: {
	before: string[];
	after: string[];
	registry: StatusRegistry;
	settings: TaskLiteSettings;
}): string | null {
	if (before.length !== after.length) return null;
	const match = findExternallyChangedLine(before, after, registry);
	if (!match) return null;

	const mutate = match.newStatus === "DONE" ? finishTaskAtLine : cancelTaskAtLine;
	const result = mutate({lines: before, lineNumber: match.lineNumber, metadata: null, registry, settings});
	if (!result) return null;

	const lines = [...before];
	lines.splice(result.fromLine, result.toLine - result.fromLine + 1, ...result.replacement);
	return lines.join("\n");
}

function findExternallyChangedLine(
	before: string[],
	after: string[],
	registry: StatusRegistry,
): {lineNumber: number; newStatus: "DONE" | "CANCELLED"} | null {
	const beforeTree = buildTaskTree(before, null, registry);
	const afterTree = buildTaskTree(after, null, registry);
	for (const [lineNumber, afterNode] of afterTree.byLine) {
		if (!afterNode.task) continue;
		const newStatus = afterNode.task.data.status;
		// Only reconcile transitions to terminal states that have no date stamp yet
		if (newStatus !== "DONE" && newStatus !== "CANCELLED") continue;
		if (newStatus === "DONE" && afterNode.task.data.dates.done) continue;
		if (newStatus === "CANCELLED" && afterNode.task.data.dates.cancelled) continue;

		const beforeNode = beforeTree.byLine.get(lineNumber);
		if (!beforeNode?.task || beforeNode.task.data.status === newStatus) continue;
		if (taskIdentityKey(beforeNode.task.data) === taskIdentityKey(afterNode.task.data))
			return {lineNumber, newStatus};
	}
	return null;
}
