import type { App, CachedMetadata, Editor, TFile } from "obsidian";
import {
	cancelTaskAtLine,
	finishTaskAtLine,
	toggleTaskAtLine,
	uncancelTaskAtLine,
	unfinishTaskAtLine,
	type ToggleResult,
} from "../editor/toggle";
import { parseTaskLine, serializeTaskLine, type TaskLine } from "../model/format";
import { taskIdentityKey } from "../model/taskIdentity";
import { applyTaskStatus } from "../model/taskState";
import { buildTaskTree } from "../model/tree";
import type { StatusRegistry } from "../model/status";
import type { TaskLiteSettings } from "../settings";

export interface TaskLiteTaskRecord {
	path: string;
	basename: string;
	lineNumber: number;
	parentLine: number | null;
	depth: number;
	hasChildren: boolean;
	task: TaskLine;
}

export interface ListTasksOptions {
	includeCompleted?: boolean;
	includeCancelled?: boolean;
	includeChildren?: boolean;
}

export interface CreateTaskOptions {
	path?: string;
	parentLineNumber?: number;
}

export interface TaskLiteCoreApi {
	listTasks(options?: ListTasksOptions): Promise<TaskLiteTaskRecord[]>;
	finishTask(path: string, lineNumber: number): Promise<boolean>;
	unfinishTask(path: string, lineNumber: number): Promise<boolean>;
	cancelTask(path: string, lineNumber: number): Promise<boolean>;
	uncancelTask(path: string, lineNumber: number): Promise<boolean>;
	createTask(line: string, options?: CreateTaskOptions): Promise<void>;
	executeTasksToggleCommand(line: string, path: string): string;
}

interface TaskLiteCoreApiOptions {
	app: App;
	registry: StatusRegistry;
	getSettings: () => TaskLiteSettings;
}

interface AppLike {
	workspace?: {
		activeEditor?: unknown;
		getLeavesOfType?: (viewType: string) => Array<{view: unknown}>;
	};
}

interface MarkdownEditorInfoLike {
	file?: TFile | null;
	editor?: Editor;
}

export function createTaskLiteCoreApi({app, registry, getSettings}: TaskLiteCoreApiOptions): TaskLiteCoreApi {
	return {
		listTasks: (options) => listTasks({app, registry, options}),
		finishTask: (path, lineNumber) => updateFileTask({app, path, lineNumber, registry, settings: getSettings(), mutate: finishTaskAtLine}),
		unfinishTask: (path, lineNumber) => updateFileTask({app, path, lineNumber, registry, settings: getSettings(), mutate: unfinishTaskAtLine}),
		cancelTask: (path, lineNumber) => updateFileTask({app, path, lineNumber, registry, settings: getSettings(), mutate: cancelTaskAtLine}),
		uncancelTask: (path, lineNumber) => updateFileTask({app, path, lineNumber, registry, settings: getSettings(), mutate: uncancelTaskAtLine}),
		createTask: (line, options) => createTask({app, line, options, settings: getSettings()}),
		executeTasksToggleCommand: (line, path) => {
			const context = findOpenEditorTaskContext(app, line, path);
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
	options = {},
}: {
	app: App;
	registry: StatusRegistry;
	options?: ListTasksOptions;
}): Promise<TaskLiteTaskRecord[]> {
	const records: TaskLiteTaskRecord[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		const content = await app.vault.cachedRead(file);
		const lines = content.split("\n");
		const tree = buildTaskTree(lines, app.metadataCache.getFileCache(file), registry);
		for (const node of tree.nodes) {
			if (!node.task) continue;
			if (!options.includeChildren && node.parent) continue;
			if (!options.includeCompleted && node.task.status.type === "DONE") continue;
			if (!options.includeCancelled && node.task.status.type === "CANCELLED") continue;
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
	return records;
}

async function createTask({
	app,
	line,
	options,
	settings,
}: {
	app: App;
	line: string;
	options: CreateTaskOptions | undefined;
	settings: TaskLiteSettings;
}): Promise<void> {
	const inboxPath = normalizePath(options?.path || "Tasks/New_Tasks.md");
	let file = app.vault.getAbstractFileByPath(inboxPath);
	if (!file) {
		file = await app.vault.create(inboxPath, "");
	}
	if (!isTFile(file)) {
		throw new Error("TaskLite inbox path points to a folder.");
	}

	const content = await app.vault.read(file);
	const lines = content.length > 0 ? content.split("\n") : [];
	const insertion = formatCreatedTaskLine(line, lines, options?.parentLineNumber);
	if (typeof options?.parentLineNumber === "number" && options.parentLineNumber >= 0 && options.parentLineNumber < lines.length) {
		lines.splice(options.parentLineNumber + 1, 0, insertion);
		await app.vault.modify(file, lines.join("\n"));
		return;
	}

	const separator = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
	await app.vault.modify(file, `${content}${separator}${insertion}\n`);
}

async function updateFileTask({
	app,
	path,
	lineNumber,
	registry,
	settings,
	mutate,
}: {
	app: App;
	path: string;
	lineNumber: number;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
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
	const content = await app.vault.read(file);
	const lines = content.split("\n");
	const result = mutate({
		lines,
		lineNumber,
		metadata: app.metadataCache.getFileCache(file),
		registry,
		settings,
	});
	if (!result) return false;

	lines.splice(result.fromLine, result.toLine - result.fromLine + 1, ...result.replacement);
	await app.vault.modify(file, lines.join("\n"));
	return true;
}

function formatCreatedTaskLine(line: string, lines: string[], parentLineNumber: number | undefined): string {
	if (typeof parentLineNumber !== "number" || parentLineNumber < 0 || parentLineNumber >= lines.length) return line;
	const parentIndentation = lines[parentLineNumber]?.match(/^([\s\t>]*)/u)?.[1] ?? "";
	return `${parentIndentation}\t${line.trimStart()}`;
}

function executeSingleLineApiToggle(line: string, registry: StatusRegistry, settings: TaskLiteSettings): string {
	const statusSymbol = line.match(/\[(.)\]/u)?.[1] ?? " ";
	const task = parseTaskLine(line, registry.get(statusSymbol));
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
	const statusSymbol = line.match(/\[(.)\]/u)?.[1] ?? " ";
	const task = parseTaskLine(line, registry.get(statusSymbol));
	if (!task) return line;

	return serializeTaskLine(applyTaskStatus(task, task.status, settings, {fillMissingStatusDate: true}));
}

function findOpenEditorTaskContext(
	app: App,
	line: string,
	path: string,
): {lines: string[]; lineNumber: number; metadata: CachedMetadata | null} | null {
	const editor = findOpenMarkdownEditor(app, path);
	if (!editor) return null;

	const lines = editor.getValue().split("\n");
	const lineNumber = findMatchingTaskLine(lines, line);
	if (lineNumber < 0) return null;

	return {lines, lineNumber, metadata: null};
}

function findMatchingTaskLine(lines: string[], line: string): number {
	const exactLineNumber = lines.findIndex((candidate) => candidate === line);
	if (exactLineNumber >= 0) return exactLineNumber;

	const incomingTask = parseLineWithStatus(line);
	if (!incomingTask) return -1;

	const incomingKey = taskIdentityKey(incomingTask);
	return lines.findIndex((candidate) => {
		const candidateTask = parseLineWithStatus(candidate);
		return candidateTask ? taskIdentityKey(candidateTask) === incomingKey : false;
	});
}

function parseLineWithStatus(line: string): TaskLine | null {
	const statusSymbol = line.match(/\[(.)\]/u)?.[1] ?? " ";
	return parseTaskLine(line, {symbol: statusSymbol, name: "", nextStatusSymbol: "x", availableAsCommand: false, type: "TODO"});
}

function findOpenMarkdownEditor(app: App, path: string): Editor | null {
	const workspace = (app as AppLike | undefined)?.workspace;
	if (!workspace) return null;

	const activeEditor = getEditorForPath(workspace.activeEditor, path);
	if (activeEditor) return activeEditor;

	for (const leaf of workspace.getLeavesOfType?.("markdown") ?? []) {
		const editor = getEditorForPath(leaf.view, path);
		if (editor) return editor;
	}

	return null;
}

function getEditorForPath(value: unknown, path: string): Editor | null {
	const info = value as MarkdownEditorInfoLike | null | undefined;
	if (info?.file?.path === path && info.editor) return info.editor;
	return null;
}

function taskDepth(node: {parent: unknown | null}): number {
	let depth = 0;
	let current = node.parent as {parent: unknown | null} | null;
	while (current) {
		depth++;
		current = current.parent as {parent: unknown | null} | null;
	}
	return depth;
}

function isTFile(value: unknown): value is TFile {
	const file = value as Partial<TFile> | null | undefined;
	return Boolean(file && typeof file.path === "string" && typeof file.extension === "string");
}

function normalizePath(path: string): string {
	return path.replace(/\\/gu, "/").replace(/\/+/gu, "/").replace(/^\/+/u, "");
}
