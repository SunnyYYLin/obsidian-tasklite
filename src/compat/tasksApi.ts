import type { App } from "obsidian";
import type TaskLitePlugin from "../main";
import { toggleTaskAtLine } from "../editor/toggle";

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
		executeToggleTaskDoneCommand: (line: string) => {
			const result = toggleTaskAtLine({
				lines: [line],
				lineNumber: 0,
				metadata: null,
				registry: plugin.statusRegistry,
				settings: plugin.settings,
			});
			return result?.replacement.join("\n") ?? line;
		},
	};
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
