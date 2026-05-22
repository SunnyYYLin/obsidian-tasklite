import { toggleTaskAtLine } from "./toggle";
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
	const lineNumber = findExternallyCompletedLine(before, after, registry);
	if (lineNumber === null) return null;

	const result = toggleTaskAtLine({lines: before, lineNumber, metadata: null, registry, settings});
	if (!result) return null;

	const lines = [...before];
	lines.splice(result.fromLine, result.toLine - result.fromLine + 1, ...result.replacement);
	return lines.join("\n");
}

function findExternallyCompletedLine(before: string[], after: string[], registry: StatusRegistry): number | null {
	const beforeTree = buildTaskTree(before, null, registry);
	const afterTree = buildTaskTree(after, null, registry);
	for (const [lineNumber, afterNode] of afterTree.byLine) {
		if (!afterNode.task || afterNode.task.status.type !== "DONE" || afterNode.task.metadata.dates.done) continue;
		const beforeNode = beforeTree.byLine.get(lineNumber);
		if (!beforeNode?.task || beforeNode.task.status.type === "DONE") continue;
		if (taskIdentityKey(beforeNode.task) === taskIdentityKey(afterNode.task)) return lineNumber;
	}
	return null;
}
