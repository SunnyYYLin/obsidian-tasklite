import { Plugin } from "obsidian";
import { createTaskLiteCoreApi, type TaskLiteCoreApi } from "./api/taskLiteCoreApi";
import { registerTaskLiteCore } from "./core/registerCore";
import { StatusRegistry } from "./model/status";
import { TaskDocumentStore, type TaskDocumentRecord } from "./model/taskDocumentStore";
import {
	DEFAULT_SETTINGS,
	mergeSettings,
	type TaskLiteSettings,
} from "./settings";
import { normalizeAssignees } from "./model/assignee";

export default class TaskLitePlugin extends Plugin {
	settings: TaskLiteSettings = DEFAULT_SETTINGS;
	readonly statusRegistry = new StatusRegistry();
	readonly documentStore = new TaskDocumentStore(this.app, this.statusRegistry);
	api!: TaskLiteCoreApi;
	private assigneeRefreshTimer: ReturnType<typeof setTimeout> | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.api = createTaskLiteCoreApi({
			app: this.app,
			registry: this.statusRegistry,
			getSettings: () => this.settings,
			documentStore: this.documentStore,
		});
		await this.updateAssigneesFromVault();
		this.documentStore.onRecordUpdated = () => {
			this.queueAssigneeRefresh();
		};
		this.documentStore.register(this);
		registerTaskLiteCore(this);

		this.app.workspace.onLayoutReady(async () => {
			await this.updateAssigneesFromVault();
		});
	}

	onunload(): void {
		if (this.assigneeRefreshTimer !== null) {
			clearTimeout(this.assigneeRefreshTimer);
			this.assigneeRefreshTimer = null;
		}
		this.documentStore.destroy();
	}

	async loadSettings(): Promise<void> {
		const loaded = (await this.loadData()) as Partial<TaskLiteSettings> | null;
		this.settings = mergeSettings(loaded);
		if (JSON.stringify(loaded?.assignees ?? []) !== JSON.stringify(this.settings.assignees)) {
			await this.saveData(this.settings);
		}
	}

	async saveSettings(): Promise<void> {
		this.settings.assignees = normalizeAssignees(this.settings.assignees);
		this.documentStore.invalidateAll();
		await this.saveData(this.settings);
	}

	async updateAssigneesFromVault(): Promise<void> {
		const records = await this.documentStore.listRecords();
		await this.updateAssigneesFromRecords(records);
	}

	private queueAssigneeRefresh(): void {
		if (this.assigneeRefreshTimer !== null) {
			clearTimeout(this.assigneeRefreshTimer);
		}
		this.assigneeRefreshTimer = setTimeout(() => {
			this.assigneeRefreshTimer = null;
			void this.updateAssigneesFromVault();
		}, 200);
	}

	private async updateAssigneesFromRecords(records: TaskDocumentRecord[]): Promise<void> {
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
		const normalized = normalizeAssignees(Array.from(assignees));
		const current = this.settings.assignees || [];
		if (JSON.stringify(normalized) !== JSON.stringify(current)) {
			this.settings.assignees = normalized;
			await this.saveData(this.settings);
		}
	}
}
