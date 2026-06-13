import { Plugin } from "obsidian";
import { createTaskLiteCoreApi, type TaskLiteCoreApi } from "./api/taskLiteCoreApi";
import { registerTaskLiteCore } from "./core/registerCore";
import { StatusRegistry } from "./model/status";
import { TaskDocumentStore } from "./model/taskDocumentStore";
import {
	DEFAULT_SETTINGS,
	mergeSettings,
	type TaskLiteSettings,
} from "./settings";

export default class TaskLitePlugin extends Plugin {
	settings: TaskLiteSettings = DEFAULT_SETTINGS;
	readonly statusRegistry = new StatusRegistry();
	readonly documentStore = new TaskDocumentStore(this.app, this.statusRegistry);
	api!: TaskLiteCoreApi;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.api = createTaskLiteCoreApi({
			app: this.app,
			registry: this.statusRegistry,
			getSettings: () => this.settings,
			documentStore: this.documentStore,
		});
		this.documentStore.register(this);
		registerTaskLiteCore(this);

		this.app.workspace.onLayoutReady(async () => {
			await this.updateAssigneesFromVault();
		});
	}

	onunload(): void {
		this.documentStore.destroy();
	}

	async loadSettings(): Promise<void> {
		this.settings = mergeSettings((await this.loadData()) as Partial<TaskLiteSettings> | null);
	}

	async saveSettings(): Promise<void> {
		this.documentStore.invalidateAll();
		await this.saveData(this.settings);
	}

	async updateAssigneesFromVault(): Promise<void> {
		const records = await this.documentStore.listRecords();
		const assignees = new Set<string>();
		for (const r of records) {
			if (r.task.assignee) {
				for (const a of r.task.assignee) {
					const trimmed = a.trim();
					if (trimmed) {
						assignees.add(trimmed);
					}
				}
			}
		}
		const sorted = Array.from(assignees).sort();
		const current = this.settings.assignees || [];
		if (JSON.stringify(sorted) !== JSON.stringify(current)) {
			this.settings.assignees = sorted;
			await this.saveData(this.settings);
		}
	}
}
