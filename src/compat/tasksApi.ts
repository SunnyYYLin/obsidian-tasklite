import type { App, CachedMetadata, Editor, TFile } from "obsidian";
import type TaskLitePlugin from "../main";
import { toggleTaskAtLine } from "../editor/toggle";
import { parseTaskLine, serializeTaskLine, type TaskLine } from "../model/format";
import { taskIdentityKey } from "../model/taskIdentity";
import { applyTaskStatus } from "../model/taskState";

const TASKS_PLUGIN_ID = "obsidian-tasks-plugin";

export interface TasksPluginApiV1 {
	isTasksPluginEnabled(): boolean;
	createTaskLineModal(): Promise<string>;
	editTaskLineModal(taskLine: string): Promise<string>;
	executeToggleTaskDoneCommand(line: string, path: string): string;
}

interface AppWithPlugins extends App {
	plugins?: {
		plugins?: Record<string, unknown>;
	};
}

interface TasksPluginLike {
	apiV1?: TasksPluginApiV1;
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

interface OpenTaskLineModalOptions {
	app: App;
	title: string;
	initialLine: string;
	registry: TaskLitePlugin["statusRegistry"];
	settings: TaskLitePlugin["settings"];
}

type OpenTaskLineModal = (options: OpenTaskLineModalOptions) => Promise<string>;

export function createTasksApiV1(plugin: TaskLitePlugin, openModal: OpenTaskLineModal = defaultOpenTaskLineModal): TasksPluginApiV1 {
	return {
		isTasksPluginEnabled: () => true,
		createTaskLineModal: () =>
			openModal({
				app: plugin.app,
				title: "Create task",
				initialLine: "",
				registry: plugin.statusRegistry,
				settings: plugin.settings,
			}),
		editTaskLineModal: (taskLine: string) =>
			openModal({
				app: plugin.app,
				title: "Edit task",
				initialLine: taskLine,
				registry: plugin.statusRegistry,
				settings: plugin.settings,
			}),
		executeToggleTaskDoneCommand: (line: string, path: string) => {
			const context = findOpenEditorTaskContext(plugin.app, line, path);
			if (!context) return executeSingleLineApiToggle(line, plugin);
			const result = toggleTaskAtLine({
				...context,
				registry: plugin.statusRegistry,
				settings: plugin.settings,
			});
			return result?.replacement.join("\n") ?? line;
		},
	};
}

function executeSingleLineApiToggle(line: string, plugin: TaskLitePlugin): string {
	const statusSymbol = line.match(/\[(.)\]/u)?.[1] ?? " ";
	const task = parseTaskLine(line, plugin.statusRegistry.get(statusSymbol));
	if (task?.status.type === "DONE" || task?.status.type === "CANCELLED") {
		return normalizeApiToggledLine(line, plugin);
	}

	const result = toggleTaskAtLine({
		lines: [line],
		lineNumber: 0,
		metadata: null,
		registry: plugin.statusRegistry,
		settings: plugin.settings,
	});
	return result?.replacement.join("\n") ?? line;
}

function normalizeApiToggledLine(line: string, plugin: TaskLitePlugin): string {
	const statusSymbol = line.match(/\[(.)\]/u)?.[1] ?? " ";
	const task = parseTaskLine(line, plugin.statusRegistry.get(statusSymbol));
	if (!task) return line;

	return serializeTaskLine(applyTaskStatus(task, task.status, plugin.settings, {fillMissingStatusDate: true}));
}

function findOpenEditorTaskContext(
	app: App,
	line: string,
	path: string,
): {lines: string[]; lineNumber: number; metadata: CachedMetadata | null} | null {
	const editor = findOpenMarkdownEditor(app, path);
	if (!editor) return null;

	const lines = editor.getValue().split("\n");
	const lineNumber = findMatchingTaskLine(lines, line, app, path);
	if (lineNumber < 0) return null;

	return {lines, lineNumber, metadata: null};
}

function findMatchingTaskLine(lines: string[], line: string, _app: App, _path: string): number {
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

async function defaultOpenTaskLineModal(options: OpenTaskLineModalOptions): Promise<string> {
	const {openTaskLineModal} = await import("../ui/taskLineModal");
	return openTaskLineModal(options);
}

export function registerTasksApiShim(plugin: TaskLitePlugin): () => void {
	const plugins = (plugin.app as AppWithPlugins).plugins?.plugins;
	if (!plugins) return () => undefined;

	const existing = plugins[TASKS_PLUGIN_ID] as TasksPluginLike | undefined;
	if (existing?.apiV1) return () => undefined;

	const shim: TasksPluginLike = {apiV1: createTasksApiV1(plugin)};
	plugins[TASKS_PLUGIN_ID] = shim;

	return () => {
		if (plugins[TASKS_PLUGIN_ID] === shim) {
			delete plugins[TASKS_PLUGIN_ID];
		}
	};
}
