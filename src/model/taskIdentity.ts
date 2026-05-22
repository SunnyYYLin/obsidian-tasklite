import { copyTaskMetadata, serializeTaskBody, type TaskLine } from "./format";

export function taskIdentityKey(task: TaskLine): string {
	const metadata = copyTaskMetadata(task.metadata);
	metadata.dates.done = null;
	metadata.dates.cancelled = null;
	return serializeTaskBody(metadata);
}
