import { Plugin } from "obsidian";
import { createTaskLiteCoreApi, type TaskLiteCoreApi } from "./api/taskLiteCoreApi";
import { registerTaskLiteCore } from "./core/registerCore";
import { StatusRegistry } from "./model/status";
import { TaskDocumentStore } from "./model/taskDocumentStore";
import {
	DEFAULT_SETTINGS,
	importTasksStatusSettings,
	mergeSettings,
	type TaskLiteSettings,
} from "./settings";

export default class TaskLitePlugin extends Plugin {
	settings: TaskLiteSettings = DEFAULT_SETTINGS;
	readonly statusRegistry = new StatusRegistry(DEFAULT_SETTINGS.statusSettings);
	readonly documentStore = new TaskDocumentStore(this.app, this.statusRegistry);
	api!: TaskLiteCoreApi;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.statusRegistry.set(this.settings.statusSettings);
		this.api = createTaskLiteCoreApi({
			app: this.app,
			registry: this.statusRegistry,
			getSettings: () => this.settings,
			documentStore: this.documentStore,
		});
		this.documentStore.register(this);
		registerTaskLiteCore(this);
	}

	onunload(): void {
	}

	async loadSettings(): Promise<void> {
		this.settings = mergeSettings((await this.loadData()) as Partial<TaskLiteSettings> | null);
	}

	async saveSettings(): Promise<void> {
		this.statusRegistry.set(this.settings.statusSettings);
		this.documentStore.invalidateAll();
		await this.saveData(this.settings);
	}

	async importTasksStatusSettings(): Promise<boolean> {
		try {
			const imported = await importTasksStatusSettings(this.app);
			if (!imported) return false;
			this.settings.statusSettings = imported;
			this.statusRegistry.set(imported);
			await this.saveSettings();
			return true;
		} catch (error) {
			console.warn("TaskLite failed to import Tasks settings", error);
			return false;
		}
	}
}
