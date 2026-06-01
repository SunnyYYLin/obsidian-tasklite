import { copyTaskData, type TaskData } from "./format";
import type { StatusRegistry, StatusType } from "./status";
import { todayString } from "./recurrence";
import type { TaskLiteSettings } from "../settings";

export function applyTaskStatus(
	task: TaskData,
	statusType: StatusType,
	settings: TaskLiteSettings,
	options: {fillMissingStatusDate?: boolean} = {},
): TaskData {
	const data = copyTaskData(task);
	if (statusType === "DONE") {
		if (settings.setDoneDate && (task.status !== "DONE" || options.fillMissingStatusDate) && !data.dates.done) {
			data.dates.done = todayString();
		}
		data.dates.cancelled = null;
	} else {
		data.dates.done = null;
	}
	if (statusType === "CANCELLED") {
		if (settings.setCancelledDate && (task.status !== "CANCELLED" || options.fillMissingStatusDate) && !data.dates.cancelled) {
			data.dates.cancelled = todayString();
		}
	} else {
		data.dates.cancelled = null;
	}
	data.status = statusType;
	return data;
}

export function toggleTaskStatus(task: TaskData, registry: StatusRegistry, settings: TaskLiteSettings): TaskData {
	const currentSymbol = registry.getByType(task.status).symbol;
	const nextStatus = registry.next(registry.get(currentSymbol));
	return applyTaskStatus(task, nextStatus.type, settings);
}
