import type { App, CachedMetadata, TFile } from "obsidian";
import {
	changeTaskStatusAtLine,
	toggleTaskAtLine,
	getIndentPrefix,
	type ToggleResult,
} from "../editor/toggle";
import { findOpenMarkdownEditor } from "../editor/editorUtils";
import {
	copyTaskData,
	parseLineWithStatus,
	serializeTaskLine,
	type TaskLine,
	type TaskPriority,
	type OnCompletionAction,
	type TaskData,
} from "../model/format";
import { taskIdentityKey } from "../model/taskIdentity";
import { applyTaskStatus } from "../model/taskState";
import {
	buildTaskTree,
	getSubtreeNodes,
	taskDepth,
	getTaskParentLine,
} from "../model/tree";
import type {
	TaskDocumentStore,
	TaskDocumentRecord,
} from "../model/taskDocumentStore";
import {
	parseFrontmatterTask,
	buildFrontmatterPatch,
	applyFrontmatterPatchToContent,
} from "../model/frontmatterTask";
import { filterTaskRecordsByQuery } from "../model/taskQuery";
import { type StatusRegistry, type StatusType } from "../model/status";
import type { TaskLiteSettings } from "../settings";

/** TaskLiteTaskRecord 与 TaskDocumentRecord 共享同一个形状，此处直接复用，避免类型重复定义 */
export type TaskLiteTaskRecord = TaskDocumentRecord;

export interface ListTasksOptions {
	includeCompleted?: boolean;
	includeCancelled?: boolean;
	includeChildren?: boolean;
	query?: string;
}

export interface CreateTaskInput {
	description: string;
	status?: string;
	priority?: TaskPriority | string | null;
	dates?: {
		start?: string | null;
		scheduled?: string | null;
		due?: string | null;
		remind?: string | null;
	};
	recurrence?: string | null;
	onCompletion?: OnCompletionAction | null;
	id?: string | null;
	dependsOn?: string | null;
	assignee?: string[];
	path?: string;
	parentLineNumber?: number;
}

export type EditTaskPatch = {
	description?: string;
	priority?: TaskPriority | string | null;
	dates?: {
		start?: string | null;
		scheduled?: string | null;
		due?: string | null;
		remind?: string | null;
	};
	recurrence?: string | null;
	onCompletion?: OnCompletionAction | null;
	id?: string | null;
	dependsOn?: string | null;
	assignee?: string[];
};

export interface TaskLiteCoreApi {
	/**
	 * Return all tasks, including line-level tasks (ordinary list items)
	 * and file-level tasks (encoded in YAML frontmatter with `task: true`).
	 */
	listTasks(options?: ListTasksOptions): Promise<TaskLiteTaskRecord[]>;
	filterTasks(
		records: TaskLiteTaskRecord[],
		query: string,
	): TaskLiteTaskRecord[];
	/**
	 * Return all file-level tasks (encoded in YAML frontmatter with `task: true`).
	 */
	listFrontmatterTasks(): Promise<TaskLiteTaskRecord[]>;
	/**
	 * Transition the status of the task at `lineNumber` in `path` to the target status symbol.
	 * This triggers appropriate tree cascades (e.g. finishing subtasks when set to DONE,
	 * unfinishing parents when set to TODO) and recurrence rules.
	 * Returns `true` if the task was found and updated, `false` otherwise.
	 */
	updateTaskStatus(
		path: string,
		lineNumber: number,
		statusSymbol: string,
	): Promise<boolean>;
	createTask(input: CreateTaskInput): Promise<void>;
	/**
	 * Delete the task at `lineNumber` and its entire subtree from the file at `path`.
	 * Returns `true` if the task was found and deleted, `false` otherwise.
	 */
	deleteTask(path: string, lineNumber: number): Promise<boolean>;
	/**
	 * Atomically patch metadata fields of the task at `lineNumber` in `path`.
	 * Only the keys present in `patch` are updated; status changes are NOT allowed here.
	 * Returns `true` if the task was found and patched, `false` otherwise.
	 */
	editTask(
		path: string,
		lineNumber: number,
		patch: EditTaskPatch,
	): Promise<boolean>;
	/**
	 * Perform a Tasks-plugin-compatible toggle on a **single task line string** and return
	 * the resulting line(s) as a string (multi-line when a recurrence occurrence is generated).
	 *
	 * When the file is currently open in an editor, the full TaskLite toggle logic is used,
	 * including cascade (children/parents) and recurrence.
	 *
	 * When **no editor is open** for the given `path`, only the single supplied `line` is
	 * toggled — **cascade and parent-propagation are NOT applied**. If you need full cascade
	 * without an open editor, use the async `updateTaskStatus` method instead.
	 */
	executeTasksToggleCommand(line: string, path: string): string;
}

interface TaskLiteCoreApiOptions {
	app: App;
	registry: StatusRegistry;
	getSettings: () => TaskLiteSettings;
	documentStore?: TaskDocumentStore;
}

export function createTaskLiteCoreApi({
	app,
	registry,
	getSettings,
	documentStore,
}: TaskLiteCoreApiOptions): TaskLiteCoreApi {
	return {
		listTasks: (options) =>
			listTasks({ app, registry, documentStore, options }),
		filterTasks: (records, query) =>
			filterTaskRecordsByQuery(records, query),
		listFrontmatterTasks: () =>
			listFrontmatterTasks({ app, registry, documentStore }),
		updateTaskStatus: (path, lineNumber, statusSymbol) =>
			updateFileTask({
				app,
				path,
				lineNumber,
				registry,
				settings: getSettings(),
				documentStore,
				mutate: (input) =>
					changeTaskStatusAtLine({
						...input,
						targetStatusSymbol: statusSymbol,
					}),
				statusSymbol,
			}),
		createTask: (input) =>
			createTask({
				app,
				input,
				registry,
				settings: getSettings(),
				documentStore,
			}),
		deleteTask: (path, lineNumber) =>
			deleteFileTask({ app, path, lineNumber, registry, documentStore }),
		editTask: (path, lineNumber, patch) =>
			editFileTask({
				app,
				path,
				lineNumber,
				registry,
				documentStore,
				patch,
			}),
		executeTasksToggleCommand: (line, path) => {
			const context = findOpenEditorTaskContext(
				app,
				line,
				path,
				registry,
			);
			if (!context)
				return executeSingleLineApiToggle(
					line,
					app,
					registry,
					getSettings(),
				);
			const result = toggleTaskAtLine({
				...context,
				app,
				registry,
				settings: getSettings(),
			});
			return result?.replacement.join("\n") ?? line;
		},
	};
}

async function listTasks({
	app,
	registry,
	documentStore,
	options = {},
}: {
	app: App;
	registry: StatusRegistry;
	documentStore?: TaskDocumentStore;
	options?: ListTasksOptions;
}): Promise<TaskLiteTaskRecord[]> {
	if (documentStore) {
		return filterTaskRecords(await documentStore.listRecords(), options);
	}

	const records: TaskLiteTaskRecord[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		const metadata = app.metadataCache.getFileCache(file);
		if (metadata?.frontmatter?.tasks === "ignore") continue;
		const content = await app.vault.cachedRead(file);
		const lines = content.split("\n");
		const tree = buildTaskTree(lines, metadata, registry);
		const hasBodyTasks = tree.nodes.some((n) => n.task);
		const fmRecord = parseFrontmatterTask(
			file,
			metadata,
			registry,
			hasBodyTasks,
		);
		if (fmRecord) {
			records.push(fmRecord);
		}
		for (const node of tree.nodes) {
			if (!node.task) continue;
			const taskParentLine = getTaskParentLine(node);
			const parentLine =
				fmRecord && taskParentLine === null ? -1 : taskParentLine;
			const depth =
				fmRecord && taskParentLine === null ? 0 : taskDepth(node);
			records.push({
				path: file.path,
				basename: file.basename,
				lineNumber: node.lineNumber,
				parentLine: parentLine,
				depth: depth,
				hasChildren: node.children.some((child) => child.task),
				task: node.task.data,
			});
		}
	}
	return filterTaskRecords(records, options);
}

async function createTask({
	app,
	input,
	registry,
	settings,
	documentStore,
}: {
	app: App;
	input: CreateTaskInput;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
	documentStore?: TaskDocumentStore;
}): Promise<void> {
	const statusSymbol = input.status ?? " ";
	const statusConfig = registry.get(statusSymbol);
	const taskLine: TaskLine = {
		listMarker: "-",
		data: {
			status: statusConfig.type,
			description: input.description,
			priority: normalizePriority(input.priority),
			dates: {
				start: input.dates?.start ?? null,
				created: null,
				scheduled: input.dates?.scheduled ?? null,
				due: input.dates?.due ?? null,
				done: null,
				cancelled: null,
				remind: input.dates?.remind ?? null,
			},
			recurrence: input.recurrence ?? null,
			onCompletion: input.onCompletion ?? null,
			dependsOn: input.dependsOn ?? null,
			id: input.id ?? null,
			assignee: input.assignee ?? [],
			blockLink: null,
			tags: [],
			unmatched: null,
		},
		original: "",
	};

	const inboxPath = normalizePathLocal(input.path || "Tasks/New_Tasks.md");
	let file = app.vault.getAbstractFileByPath(inboxPath);
	if (!file) {
		file = await app.vault.create(inboxPath, "");
	}
	if (!isTFile(file)) {
		throw new Error("TaskLite inbox path points to a folder.");
	}

	const content = await app.vault.read(file);
	const lines = content.length > 0 ? content.split("\n") : [];
	const metadata = app.metadataCache.getFileCache(file);
	const tree = buildTaskTree(lines, metadata, registry);
	const parentNode =
		typeof input.parentLineNumber === "number"
			? tree.byLine.get(input.parentLineNumber)
			: undefined;

	const vaultConfig = (app.vault as any).config || {};
	const useTab = vaultConfig.useTab ?? true;
	const tabSize = vaultConfig.tabSize ?? 4;
	const oneLevelIndent = useTab ? "\t" : " ".repeat(tabSize);

	const parentPrefix = parentNode ? parentNode.indentation : "";
	const indentPrefix = parentNode ? `${parentPrefix}${oneLevelIndent}` : "";
	const line = serializeTaskLine(taskLine, indentPrefix, registry);

	const insertion = parentNode
		? `${parentPrefix}${oneLevelIndent}${line.trimStart()}`
		: line;
	if (
		typeof input.parentLineNumber === "number" &&
		input.parentLineNumber >= 0 &&
		input.parentLineNumber < lines.length
	) {
		lines.splice(input.parentLineNumber + 1, 0, insertion);
		const nextContent = lines.join("\n");
		await app.vault.modify(file, nextContent);
		await documentStore?.replaceDocumentContent(file, nextContent);
		return;
	}

	const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
	const nextContent = `${content}${separator}${insertion}\n`;
	await app.vault.modify(file, nextContent);
	await documentStore?.replaceDocumentContent(file, nextContent);
}

async function deleteFileTask({
	app,
	path,
	lineNumber,
	registry,
	documentStore,
}: {
	app: App;
	path: string;
	lineNumber: number;
	registry: StatusRegistry;
	documentStore?: TaskDocumentStore;
}): Promise<boolean> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!isTFile(file)) return false;

	const document = await documentStore?.getDocumentByPath(path);
	const lines = document
		? [...document.lines]
		: (await app.vault.read(file)).split("\n");
	const tree = buildTaskTree(
		lines,
		app.metadataCache.getFileCache(file),
		registry,
	);
	if (lineNumber === -1) {
		const metadata = app.metadataCache.getFileCache(file);
		if (!metadata?.frontmatter?.task) return false;
		const fmPatch = { task: null };
		const nextContent = applyFrontmatterPatchToContent(
			lines.join("\n"),
			fmPatch,
		);
		await app.vault.modify(file, nextContent);
		await documentStore?.replaceDocumentContent(file, nextContent);
		return true;
	}

	const node = tree.byLine.get(lineNumber);
	if (!node) return false;

	const subtreeLines = getSubtreeNodes(node)
		.map((n) => n.lineNumber)
		.sort((a, b) => b - a);

	for (const ln of subtreeLines) {
		lines.splice(ln, 1);
	}

	const nextContent = lines.join("\n");
	await app.vault.modify(file, nextContent);
	await documentStore?.replaceDocumentContent(file, nextContent);
	return true;
}

async function editFileTask({
	app,
	path,
	lineNumber,
	registry,
	documentStore,
	patch,
}: {
	app: App;
	path: string;
	lineNumber: number;
	registry: StatusRegistry;
	documentStore?: TaskDocumentStore;
	patch: EditTaskPatch;
}): Promise<boolean> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!isTFile(file)) return false;

	const document = await documentStore?.getDocumentByPath(path);
	const lines = document
		? [...document.lines]
		: (await app.vault.read(file)).split("\n");
	const tree = buildTaskTree(
		lines,
		app.metadataCache.getFileCache(file),
		registry,
	);
	if (lineNumber === -1) {
		const metadata = app.metadataCache.getFileCache(file);
		const hasBodyTasks = tree.nodes.some((n) => n.task);
		const fmRecord = parseFrontmatterTask(
			file,
			metadata,
			registry,
			hasBodyTasks,
		);
		if (!fmRecord) return false;

		const data = copyTaskData(fmRecord.task);
		if (patch.description !== undefined)
			data.description = patch.description;
		if (patch.priority !== undefined)
			data.priority = normalizePriority(patch.priority);
		if (patch.recurrence !== undefined) data.recurrence = patch.recurrence;
		if (patch.onCompletion !== undefined)
			data.onCompletion = patch.onCompletion;
		if (patch.id !== undefined) data.id = patch.id;
		if (patch.dependsOn !== undefined) data.dependsOn = patch.dependsOn;
		if (patch.assignee !== undefined) data.assignee = patch.assignee;
		if (patch.dates) {
			const d = patch.dates;
			if (d.start !== undefined) data.dates.start = d.start;
			if (d.scheduled !== undefined) data.dates.scheduled = d.scheduled;
			if (d.due !== undefined) data.dates.due = d.due;
			if (d.remind !== undefined) data.dates.remind = d.remind;
		}

		const fmPatch = buildFrontmatterPatch(
			fmRecord.task,
			data,
			registry,
			fmRecord.rawStatus,
		);
		const nextContent = applyFrontmatterPatchToContent(
			lines.join("\n"),
			fmPatch,
		);
		await app.vault.modify(file, nextContent);
		await documentStore?.replaceDocumentContent(file, nextContent);
		return true;
	}

	const node = tree.byLine.get(lineNumber);
	if (!node?.task) return false;

	const data = copyTaskData(node.task.data);

	if (patch.description !== undefined) data.description = patch.description;
	if (patch.priority !== undefined)
		data.priority = normalizePriority(patch.priority);
	if (patch.recurrence !== undefined) data.recurrence = patch.recurrence;
	if (patch.onCompletion !== undefined)
		data.onCompletion = patch.onCompletion;
	if (patch.id !== undefined) data.id = patch.id;
	if (patch.dependsOn !== undefined) data.dependsOn = patch.dependsOn;
	if (patch.assignee !== undefined) data.assignee = patch.assignee;
	if (patch.dates) {
		const d = patch.dates;
		if (d.start !== undefined) data.dates.start = d.start;
		if (d.scheduled !== undefined) data.dates.scheduled = d.scheduled;
		if (d.due !== undefined) data.dates.due = d.due;
		if (d.remind !== undefined) data.dates.remind = d.remind;
	}

	const updatedTask: TaskLine = { ...node.task, data };
	const depth = taskDepth(node);
	const indent = getIndentPrefix(depth, app);
	lines[lineNumber] = serializeTaskLine(updatedTask, indent, registry);
	const nextContent = lines.join("\n");
	await app.vault.modify(file, nextContent);
	await documentStore?.replaceDocumentContent(file, nextContent);
	return true;
}

async function updateFileTask({
	app,
	path,
	lineNumber,
	registry,
	settings,
	documentStore,
	mutate,
	statusSymbol,
}: {
	app: App;
	path: string;
	lineNumber: number;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
	documentStore?: TaskDocumentStore;
	mutate: (input: {
		lines: string[];
		lineNumber: number;
		metadata: CachedMetadata | null | undefined;
		app: App;
		registry: StatusRegistry;
		settings: TaskLiteSettings;
	}) => ToggleResult | null;
	statusSymbol?: string;
}): Promise<boolean> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!isTFile(file)) return false;
	const document = await documentStore?.getDocumentByPath(path);
	const lines = document
		? [...document.lines]
		: (await app.vault.read(file)).split("\n");

	if (lineNumber === -1) {
		if (!statusSymbol) return false;
		const metadata = app.metadataCache.getFileCache(file);
		const tree = buildTaskTree(lines, metadata, registry);
		const hasBodyTasks = tree.nodes.some((n) => n.task);
		const fmRecord = parseFrontmatterTask(
			file,
			metadata,
			registry,
			hasBodyTasks,
		);
		if (!fmRecord) return false;

		const statusConfig = registry.get(statusSymbol);
		const updatedData = applyTaskStatus(
			fmRecord.task,
			statusConfig.type,
			settings,
			{ fillMissingStatusDate: true },
		);

		// Cascade to children if enabled
		const behavior =
			statusConfig.type === "DONE"
				? "finish"
				: statusConfig.type === "CANCELLED"
					? "cancel"
					: fmRecord.task.status === "CANCELLED"
						? "uncancel"
						: "unfinish";
		const cascade =
			(behavior === "finish" && settings.toggleBehavior.cascadeFinish) ||
			(behavior === "cancel" && settings.toggleBehavior.cascadeCancel) ||
			(behavior === "unfinish" &&
				settings.toggleBehavior.cascadeUnfinish) ||
			(behavior === "uncancel" &&
				settings.toggleBehavior.cascadeUncancel);

		if (cascade) {
			for (let i = 0; i < lines.length; i++) {
				const node = tree.byLine.get(i);
				if (node?.task) {
					const nodeUpdatedData = applyTaskStatus(
						node.task.data,
						statusConfig.type,
						settings,
						{ fillMissingStatusDate: true },
					);
					const depth = taskDepth(node);
					const indent = getIndentPrefix(depth, app, lines);
					lines[i] = serializeTaskLine(
						{ ...node.task, data: nodeUpdatedData },
						indent,
						registry,
					);
				}
			}
		}

		const fmPatch = buildFrontmatterPatch(
			fmRecord.task,
			updatedData,
			registry,
			fmRecord.rawStatus,
		);
		const nextContent = applyFrontmatterPatchToContent(
			lines.join("\n"),
			fmPatch,
		);
		await app.vault.modify(file, nextContent);
		await documentStore?.replaceDocumentContent(file, nextContent);
		return true;
	}

	const result = mutate({
		lines,
		lineNumber,
		metadata: app.metadataCache.getFileCache(file),
		app,
		registry,
		settings,
	});
	if (!result) return false;

	lines.splice(
		result.fromLine,
		result.toLine - result.fromLine + 1,
		...result.replacement,
	);

	// Propagate status update to frontmatter task if it exists
	const fmMetadata = app.metadataCache.getFileCache(file);
	const tempTree = buildTaskTree(lines, fmMetadata, registry);
	const hasBodyTasks = tempTree.nodes.some((n) => n.task);
	const fmRecord = parseFrontmatterTask(
		file,
		fmMetadata,
		registry,
		hasBodyTasks,
	);
	if (fmRecord) {
		const rootTasks = tempTree.nodes.filter(
			(n) => n.task && n.parentLine === null,
		);
		if (rootTasks.length > 0) {
			const currentType = fmRecord.task.status;
			let targetType: StatusType | null = null;

			const hasIncomplete = rootTasks.some(
				(n) =>
					n.task &&
					n.task.data.status !== "DONE" &&
					n.task.data.status !== "CANCELLED",
			);
			const hasCancelled = rootTasks.some(
				(n) => n.task && n.task.data.status === "CANCELLED",
			);
			const allDoneOrCancelled = rootTasks.every(
				(n) =>
					n.task &&
					(n.task.data.status === "DONE" ||
						n.task.data.status === "CANCELLED"),
			);
			const allCancelled = rootTasks.every(
				(n) => n.task && n.task.data.status === "CANCELLED",
			);

			if (hasIncomplete) {
				if (
					(currentType === "DONE" || currentType === "CANCELLED") &&
					settings.toggleBehavior.parentOnUnfinish
				) {
					targetType = "TODO";
				}
			} else if (allDoneOrCancelled) {
				if (
					currentType === "TODO" ||
					currentType === "IN_PROGRESS" ||
					currentType === "ON_HOLD"
				) {
					if (
						allCancelled &&
						settings.toggleBehavior.parentOnCancel
					) {
						targetType = "CANCELLED";
					} else if (settings.toggleBehavior.parentOnFinish) {
						targetType = "DONE";
					}
				}
			}

			if (targetType && targetType !== currentType) {
				const updatedData = applyTaskStatus(
					fmRecord.task,
					targetType,
					settings,
					{ fillMissingStatusDate: true },
				);
				const fmPatch = buildFrontmatterPatch(
					fmRecord.task,
					updatedData,
					registry,
					fmRecord.rawStatus,
				);
				const finalContent = applyFrontmatterPatchToContent(
					lines.join("\n"),
					fmPatch,
				);
				await app.vault.modify(file, finalContent);
				await documentStore?.replaceDocumentContent(file, finalContent);
				return true;
			}
		}
	}

	const nextContent = lines.join("\n");
	await app.vault.modify(file, nextContent);
	await documentStore?.replaceDocumentContent(file, nextContent);
	return true;
}

function filterTaskRecords(
	records: TaskLiteTaskRecord[],
	options: ListTasksOptions,
): TaskLiteTaskRecord[] {
	const filtered = records.filter((record) => {
		if (!options.includeChildren && record.parentLine !== null)
			return false;
		if (!options.includeCompleted && record.task.status === "DONE")
			return false;
		if (!options.includeCancelled && record.task.status === "CANCELLED")
			return false;
		return true;
	});
	return options.query
		? filterTaskRecordsByQuery(filtered, options.query)
		: filtered;
}

function executeSingleLineApiToggle(
	line: string,
	app: App,
	registry: StatusRegistry,
	settings: TaskLiteSettings,
): string {
	const task = parseLineWithStatus(line, registry);
	if (task?.data.status === "DONE" || task?.data.status === "CANCELLED") {
		return normalizeApiToggledLine(line, app, registry, settings);
	}

	const result = toggleTaskAtLine({
		lines: [line],
		lineNumber: 0,
		metadata: null,
		app,
		registry,
		settings,
	});
	return result?.replacement.join("\n") ?? line;
}

function normalizeApiToggledLine(
	line: string,
	app: App,
	registry: StatusRegistry,
	settings: TaskLiteSettings,
): string {
	const task = parseLineWithStatus(line, registry);
	if (!task) return line;

	const updatedData = applyTaskStatus(task.data, task.data.status, settings, {
		fillMissingStatusDate: true,
	});
	const indentPrefix = line.match(/^([\s\t>]*)/)?.[0] ?? "";
	return serializeTaskLine(
		{ ...task, data: updatedData },
		indentPrefix,
		registry,
	);
}

function findOpenEditorTaskContext(
	app: App,
	line: string,
	path: string,
	registry: StatusRegistry,
): {
	lines: string[];
	lineNumber: number;
	metadata: CachedMetadata | null;
} | null {
	const editor = findOpenMarkdownEditor(app, path);
	if (!editor) return null;

	const lines = editor.getValue().split("\n");
	const lineNumber = findMatchingTaskLine(lines, line, registry);
	if (lineNumber < 0) return null;

	return { lines, lineNumber, metadata: null };
}

function findMatchingTaskLine(
	lines: string[],
	line: string,
	registry: StatusRegistry,
): number {
	const exactLineNumber = lines.findIndex((candidate) => candidate === line);
	if (exactLineNumber >= 0) return exactLineNumber;

	const incomingTask = parseLineWithStatus(line, registry);
	if (!incomingTask) return -1;

	const incomingKey = taskIdentityKey(incomingTask.data);
	return lines.findIndex((candidate) => {
		const candidateTask = parseLineWithStatus(candidate, registry);
		return candidateTask
			? taskIdentityKey(candidateTask.data) === incomingKey
			: false;
	});
}

function normalizePriority(
	pri: string | null | undefined,
): TaskPriority | null {
	if (!pri) return null;
	if (pri === "highest" || pri === "🔺") return "highest";
	if (pri === "high" || pri === "⏫") return "high";
	if (pri === "medium" || pri === "🔼") return "medium";
	if (pri === "low" || pri === "🔽") return "low";
	if (pri === "lowest" || pri === "⏬") return "lowest";
	return null;
}

function isTFile(value: unknown): value is TFile {
	const file = value as Partial<TFile> | null | undefined;
	return Boolean(
		file &&
		typeof file.path === "string" &&
		typeof file.extension === "string",
	);
}

function normalizePathLocal(path: string): string {
	return path.replace(/\\/gu, "/").replace(/\/+/gu, "/").replace(/^\/+/u, "");
}

async function listFrontmatterTasks({
	app,
	registry,
	documentStore,
}: {
	app: App;
	registry: StatusRegistry;
	documentStore?: TaskDocumentStore;
}): Promise<TaskLiteTaskRecord[]> {
	const records: TaskLiteTaskRecord[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		// Use cached document if available
		if (documentStore) {
			const doc = await documentStore.getDocument(file);
			if (doc?.frontmatterTask) {
				records.push(doc.frontmatterTask);
			}
			continue;
		}
		const metadata = app.metadataCache.getFileCache(file);
		if (metadata?.frontmatter?.tasks === "ignore") continue;
		const content = await app.vault.cachedRead(file);
		const lines = content.split("\n");
		const tree = buildTaskTree(lines, metadata, registry);
		const hasBodyTasks = tree.nodes.some((n) => n.task);
		const record = parseFrontmatterTask(
			file,
			metadata,
			registry,
			hasBodyTasks,
		);
		if (record) records.push(record);
	}
	return records;
}
