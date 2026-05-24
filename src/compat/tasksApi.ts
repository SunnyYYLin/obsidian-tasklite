import type { App } from "obsidian";
import type TaskLitePlugin from "../main";
import type { TaskLiteCoreApi } from "../api/taskLiteCoreApi";
import { t } from "../i18n";

const TASKS_PLUGIN_ID = "obsidian-tasks-plugin";

export interface TasksPluginApiV1 {
	isTasksPluginEnabled(): boolean;
	createTaskLineModal(): Promise<string>;
	editTaskLineModal(taskLine: string): Promise<string>;
	executeToggleTaskDoneCommand(line: string, path: string): string;
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
	return createTasksApiV1FromCore(plugin.api, plugin, openModal);
}

export function createTasksApiV1FromCore(
	api: TaskLiteCoreApi,
	plugin: TaskLitePlugin,
	openModal: OpenTaskLineModal = defaultOpenTaskLineModal,
): TasksPluginApiV1 {
	return {
		isTasksPluginEnabled: () => true,
		createTaskLineModal: () =>
			openModal({
				app: plugin.app,
				title: t("command.createTask"),
				initialLine: "",
				registry: plugin.statusRegistry,
				settings: plugin.settings,
			}),
		editTaskLineModal: (taskLine: string) =>
			openModal({
				app: plugin.app,
				title: t("command.editTask"),
				initialLine: taskLine,
				registry: plugin.statusRegistry,
				settings: plugin.settings,
			}),
		executeToggleTaskDoneCommand: (line: string, path: string) => {
			return api.executeTasksToggleCommand(line, path);
		},
	};
}

async function defaultOpenTaskLineModal(options: OpenTaskLineModalOptions): Promise<string> {
	const {openTaskLineModal} = await import("../ui/taskLineModal");
	return openTaskLineModal(options);
}

export function registerTasksApiShim(plugin: TaskLitePlugin): () => void {
	void plugin;
	return () => undefined;
}
