import { copyTaskMetadata, type TaskLine } from "./format";
import type { StatusRegistry, StatusType } from "./status";
import { todayString } from "./recurrence";
import type { TaskLiteSettings } from "../settings";

export function applyTaskStatus(
	task: TaskLine,
	status: { symbol: string; type: StatusType },
	settings: TaskLiteSettings,
	options: {fillMissingStatusDate?: boolean} = {},
): TaskLine {
	const metadata = copyTaskMetadata(task.metadata);
	if (status.type === "DONE") {
		if (settings.setDoneDate && (task.statusType !== "DONE" || options.fillMissingStatusDate) && !metadata.dates.done) {
			metadata.dates.done = todayString();
		}
		metadata.dates.cancelled = null;
	} else {
		metadata.dates.done = null;
	}
	if (status.type === "CANCELLED") {
		if (settings.setCancelledDate && (task.statusType !== "CANCELLED" || options.fillMissingStatusDate) && !metadata.dates.cancelled) {
			metadata.dates.cancelled = todayString();
		}
	} else {
		metadata.dates.cancelled = null;
	}
	return {
		...task,
		statusSymbol: status.symbol,
		statusType: status.type,
		metadata,
	};
}

export function toggleTaskStatus(task: TaskLine, registry: StatusRegistry, settings: TaskLiteSettings): TaskLine {
	return applyTaskStatus(task, registry.next(registry.get(task.statusSymbol)), settings);
}
