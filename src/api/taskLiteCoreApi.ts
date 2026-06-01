import type { App, CachedMetadata, TFile } from "obsidian";
import {
	cancelTaskAtLine,
	finishTaskAtLine,
	toggleTaskAtLine,
	uncancelTaskAtLine,
	unfinishTaskAtLine,
	type ToggleResult,
} from "../editor/toggle";
import { findOpenMarkdownEditor } from "../editor/editorUtils";
import { copyTaskMetadata, parseLineWithStatus, serializeTaskLine, type TaskLine, type TaskPriority, type OnCompletionAction } from "../model/format";
import { taskIdentityKey } from "../model/taskIdentity";
import { applyTaskStatus } from "../model/taskState";
import { buildTaskTree, getSubtreeNodes, taskDepth } from "../model/tree";
import type { TaskDocumentStore, TaskDocumentRecord } from "../model/taskDocumentStore";
import type { FrontmatterTaskRecord } from "../model/frontmatterTask";
import { parseFrontmatterTask } from "../model/frontmatterTask";
import type { StatusRegistry } from "../model/status";
import type { TaskLiteSettings } from "../settings";

/** TaskLiteTaskRecord 与 TaskDocumentRecord 共享同一个形状，此处直接复用，避免类型重复定义 */
export type TaskLiteTaskRecord = TaskDocumentRecord;

export interface ListTasksOptions {
	includeCompleted?: boolean;
	includeCancelled?: boolean;
	includeChildren?: boolean;
}

export interface CreateTaskInput {
	description: string;
	status?: string;
	priority?: TaskPriority | null;
	dates?: {
		start?: string | null;
		scheduled?: string | null;
		due?: string | null;
	};
	recurrence?: string | null;
	onCompletion?: OnCompletionAction | null;
	id?: string | null;
	dependsOn?: string | null;
	path?: string;
	parentLineNumber?: number;
}

/** Partial patch for task metadata fields. Omitted keys are left unchanged. */
export type EditTaskPatch = {
	description?: string;
	priority?: TaskPriority | null;
	statusSymbol?: string;
	dates?: {
		start?: string | null;
		scheduled?: string | null;
		due?: string | null;
	};
	recurrence?: string | null;
	onCompletion?: OnCompletionAction | null;
	id?: string | null;
	dependsOn?: string | null;
};

export interface TaskLiteCoreApi {
	listTasks(options?: ListTasksOptions): Promise<TaskLiteTaskRecord[]>;
	/**
	 * Return all file-level tasks (encoded in YAML frontmatter with `task: true`).
	 * These are distinct from line tasks and are NOT included in `listTasks`.
	 */
	listFrontmatterTasks(): Promise<FrontmatterTaskRecord[]>;
	finishTask(path: string, lineNumber: number): Promise<boolean>;
	unfinishTask(path: string, lineNumber: number): Promise<boolean>;
	cancelTask(path: string, lineNumber: number): Promise<boolean>;
	uncancelTask(path: string, lineNumber: number): Promise<boolean>;
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
	editTask(path: string, lineNumber: number, patch: EditTaskPatch): Promise<boolean>;
	/**
	 * Perform a Tasks-plugin-compatible toggle on a **single task line string** and return
	 * the resulting line(s) as a string (multi-line when a recurrence occurrence is generated).
	 *
	 * When the file is currently open in an editor, the full TaskLite toggle logic is used,
	 * including cascade (children/parents) and recurrence.
	 *
	 * When **no editor is open** for the given `path`, only the single supplied `line` is
	 * toggled — **cascade and parent-propagation are NOT applied**. If you need full cascade
	 * without an open editor, use the async `finishTask` / `cancelTask` / `unfinishTask` /
	 * `uncancelTask` methods instead.
	 */
	executeTasksToggleCommand(line: string, path: string): string;
}

interface TaskLiteCoreApiOptions {
	app: App;
	registry: StatusRegistry;
	getSettings: () => TaskLiteSettings;
	documentStore?: TaskDocumentStore;
}



export function createTaskLiteCoreApi({app, registry, getSettings, documentStore}: TaskLiteCoreApiOptions): TaskLiteCoreApi {
	return {
		listTasks: (options) => listTasks({app, registry, documentStore, options}),
		listFrontmatterTasks: () => listFrontmatterTasks({app, registry, documentStore}),
		finishTask: (path, lineNumber) => updateFileTask({app, path, lineNumber, registry, settings: getSettings(), documentStore, mutate: finishTaskAtLine}),
		unfinishTask: (path, lineNumber) => updateFileTask({app, path, lineNumber, registry, settings: getSettings(), documentStore, mutate: unfinishTaskAtLine}),
		cancelTask: (path, lineNumber) => updateFileTask({app, path, lineNumber, registry, settings: getSettings(), documentStore, mutate: cancelTaskAtLine}),
		uncancelTask: (path, lineNumber) => updateFileTask({app, path, lineNumber, registry, settings: getSettings(), documentStore, mutate: uncancelTaskAtLine}),
		createTask: (input) => createTask({app, input, registry, settings: getSettings(), documentStore}),
		deleteTask: (path, lineNumber) => deleteFileTask({app, path, lineNumber, registry, documentStore}),
		editTask: (path, lineNumber, patch) => editFileTask({app, path, lineNumber, registry, documentStore, patch}),
		executeTasksToggleCommand: (line, path) => {
			const context = findOpenEditorTaskContext(app, line, path, registry);
			if (!context) return executeSingleLineApiToggle(line, registry, getSettings());
			const result = toggleTaskAtLine({
				...context,
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
		for (const node of tree.nodes) {
			if (!node.task) continue;
			records.push({
				path: file.path,
				basename: file.basename,
				lineNumber: node.lineNumber,
				parentLine: node.parentLine,
				depth: taskDepth(node),
				hasChildren: node.children.some((child) => child.task),
				task: node.task,
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
	const taskLine: TaskLine = {
		indentation: "",
		listMarker: "-",
		status: registry.get(statusSymbol),
		metadata: {
			description: input.description,
			priority: input.priority ?? null,
			dates: {
				start: input.dates?.start ?? null,
				created: null,
				scheduled: input.dates?.scheduled ?? null,
				due: input.dates?.due ?? null,
				done: null,
				cancelled: null,
			},
			recurrence: input.recurrence ?? null,
			onCompletion: input.onCompletion ?? null,
			dependsOn: input.dependsOn ?? null,
			id: input.id ?? null,
			person: null,
			blockLink: null,
			tags: [],
		},
		original: "",
	};
	const line = serializeTaskLine(taskLine);

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
	const parentNode = typeof input.parentLineNumber === "number" ? tree.byLine.get(input.parentLineNumber) : undefined;
	const parentIndentation = parentNode ? parentNode.indentation : "";
	const insertion = parentNode ? `${parentIndentation}\t${line.trimStart()}` : line;
	if (typeof input.parentLineNumber === "number" && input.parentLineNumber >= 0 && input.parentLineNumber < lines.length) {
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
	const lines = document ? [...document.lines] : (await app.vault.read(file)).split("\n");
	const tree = buildTaskTree(lines, app.metadataCache.getFileCache(file), registry);
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
	const lines = document ? [...document.lines] : (await app.vault.read(file)).split("\n");
	const tree = buildTaskTree(lines, app.metadataCache.getFileCache(file), registry);
	const node = tree.byLine.get(lineNumber);
	if (!node?.task) return false;

	const metadata = copyTaskMetadata(node.task.metadata);

	if (patch.description !== undefined) metadata.description = patch.description;
	if (patch.priority !== undefined) metadata.priority = patch.priority;
	if (patch.recurrence !== undefined) metadata.recurrence = patch.recurrence;
	if (patch.onCompletion !== undefined) metadata.onCompletion = patch.onCompletion;
	if (patch.id !== undefined) metadata.id = patch.id;
	if (patch.dependsOn !== undefined) metadata.dependsOn = patch.dependsOn;
	if (patch.dates) {
		const d = patch.dates;
		if (d.start !== undefined) metadata.dates.start = d.start;
		if (d.scheduled !== undefined) metadata.dates.scheduled = d.scheduled;
		if (d.due !== undefined) metadata.dates.due = d.due;
	}

	let status = node.task.status;
	if (patch.statusSymbol !== undefined) {
		status = registry.get(patch.statusSymbol);
	}

	const updatedTask: TaskLine = {...node.task, status, metadata};
	lines[lineNumber] = serializeTaskLine(updatedTask);
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
		registry: StatusRegistry;
		settings: TaskLiteSettings;
	}) => ToggleResult | null;
}): Promise<boolean> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!isTFile(file)) return false;
	const document = await documentStore?.getDocumentByPath(path);
	const lines = document ? [...document.lines] : (await app.vault.read(file)).split("\n");
	const result = mutate({
		lines,
		lineNumber,
		metadata: app.metadataCache.getFileCache(file),
		registry,
		settings,
	});
	if (!result) return false;

	lines.splice(result.fromLine, result.toLine - result.fromLine + 1, ...result.replacement);
	const nextContent = lines.join("\n");
	await app.vault.modify(file, nextContent);
	await documentStore?.replaceDocumentContent(file, nextContent);
	return true;
}

function filterTaskRecords(records: TaskLiteTaskRecord[], options: ListTasksOptions): TaskLiteTaskRecord[] {
	return records.filter((record) => {
		if (!options.includeChildren && record.parentLine !== null) return false;
		if (!options.includeCompleted && record.task.status.type === "DONE") return false;
		if (!options.includeCancelled && record.task.status.type === "CANCELLED") return false;
		return true;
	});
}





function executeSingleLineApiToggle(line: string, registry: StatusRegistry, settings: TaskLiteSettings): string {
	const task = parseLineWithStatus(line, registry);
	if (task?.status.type === "DONE" || task?.status.type === "CANCELLED") {
		return normalizeApiToggledLine(line, registry, settings);
	}

	const result = toggleTaskAtLine({
		lines: [line],
		lineNumber: 0,
		metadata: null,
		registry,
		settings,
	});
	return result?.replacement.join("\n") ?? line;
}

function normalizeApiToggledLine(line: string, registry: StatusRegistry, settings: TaskLiteSettings): string {
	const task = parseLineWithStatus(line, registry);
	if (!task) return line;

	return serializeTaskLine(applyTaskStatus(task, task.status, settings, {fillMissingStatusDate: true}));
}

function findOpenEditorTaskContext(
	app: App,
	line: string,
	path: string,
	registry: StatusRegistry,
): {lines: string[]; lineNumber: number; metadata: CachedMetadata | null} | null {
	const editor = findOpenMarkdownEditor(app, path);
	if (!editor) return null;

	const lines = editor.getValue().split("\n");
	const lineNumber = findMatchingTaskLine(lines, line, registry);
	if (lineNumber < 0) return null;

	return {lines, lineNumber, metadata: null};
}

function findMatchingTaskLine(lines: string[], line: string, registry: StatusRegistry): number {
	const exactLineNumber = lines.findIndex((candidate) => candidate === line);
	if (exactLineNumber >= 0) return exactLineNumber;

	const incomingTask = parseLineWithStatus(line, registry);
	if (!incomingTask) return -1;

	const incomingKey = taskIdentityKey(incomingTask);
	return lines.findIndex((candidate) => {
		const candidateTask = parseLineWithStatus(candidate, registry);
		return candidateTask ? taskIdentityKey(candidateTask) === incomingKey : false;
	});
}





function isTFile(value: unknown): value is TFile {
	const file = value as Partial<TFile> | null | undefined;
	return Boolean(file && typeof file.path === "string" && typeof file.extension === "string");
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
}): Promise<FrontmatterTaskRecord[]> {
	const records: FrontmatterTaskRecord[] = [];
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
		const record = parseFrontmatterTask(file, metadata, registry, hasBodyTasks);
		if (record) records.push(record);
	}
	return records;
}

