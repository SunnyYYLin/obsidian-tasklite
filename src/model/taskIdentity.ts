import type { TaskData } from "./format";

/**
 * A stable identity key for a task used to match tasks across state changes
 * (e.g. before/after external edits).  Built from structural fields rather than
 * a full serialization so it is insensitive to field ordering and trailing whitespace.
 * The NUL character (\0) is used as separator to prevent cross-field collisions.
 */
export function taskIdentityKey(task: TaskData): string {
	return [
		task.description.trim(),
		task.priority ?? "",
		task.recurrence ?? "",
		task.id ?? "",
		task.dates.start ?? "",
		task.dates.scheduled ?? "",
		task.dates.due ?? "",
	].join("\0");
}
