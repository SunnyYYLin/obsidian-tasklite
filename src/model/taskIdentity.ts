import { copyTaskData, serializeTaskBody, type TaskData } from "./format";

export function taskIdentityKey(task: TaskData): string {
	const data = copyTaskData(task);
	data.dates.done = null;
	data.dates.cancelled = null;
	return serializeTaskBody(data);
}
