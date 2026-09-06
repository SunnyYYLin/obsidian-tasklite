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
	private assigneeRefreshTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.api = createTaskLiteCoreApi({
			app: this.app,
			registry: this.statusRegistry,
			getSettings: () => this.settings,
			documentStore: this.documentStore,
			getDefaultAssignee: () => this.getDefaultAssignee(),
			setDefaultAssignee: (a) => this.setDefaultAssignee(a),
		});
		await this.updateMetadataFromVault();
		this.documentStore.onRecordUpdated = () => {
			this.queueMetadataRefresh();
		};
		this.documentStore.register(this);
		registerTaskLiteCore(this);

		this.app.workspace.onLayoutReady(async () => {
			await this.updateMetadataFromVault();
		});
	}

	onunload(): void {
		if (this.assigneeRefreshTimer !== null) {
			window.clearTimeout(this.assigneeRefreshTimer);
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

	getDefaultAssignee(): string {
		if (this.settings.storeDefaultAssigneeLocally) {
			try {
				const storageKey = this.getDefaultAssigneeStorageKey();
				const localVal = window.localStorage?.getItem(storageKey);
				if (localVal !== null && localVal !== undefined) {
					return localVal;
				}
			} catch {
				// Local storage unavailable
			}
		}
		return this.settings.defaultAssignee || "";
	}

	async setDefaultAssignee(assignee: string): Promise<void> {
		const trimmed = assignee.trim();
		if (this.settings.storeDefaultAssigneeLocally) {
			try {
				const storageKey = this.getDefaultAssigneeStorageKey();
				if (trimmed) {
					window.localStorage?.setItem(storageKey, trimmed);
				} else {
					window.localStorage?.removeItem(storageKey);
				}
			} catch {
				// Local storage unavailable
			}
		}
		this.settings.defaultAssignee = trimmed;
		await this.saveSettings();
	}

	private getDefaultAssigneeStorageKey(): string {
		const vaultId = (this.app as unknown as { appId?: string }).appId || this.app.vault?.getName() || "default";
		return `tasklite:defaultAssignee:${vaultId}`;
	}

	async updateMetadataFromVault(): Promise<void> {
		const records = await this.documentStore.listRecords();
		await this.updateMetadataFromRecords(records);
	}

	async updateAssigneesFromVault(): Promise<void> {
		await this.updateMetadataFromVault();
	}

	private queueMetadataRefresh(): void {
		if (this.assigneeRefreshTimer !== null) {
			window.clearTimeout(this.assigneeRefreshTimer);
		}
		this.assigneeRefreshTimer = window.setTimeout(() => {
			this.assigneeRefreshTimer = null;
			void this.updateMetadataFromVault();
		}, 200);
	}

	private queueAssigneeRefresh(): void {
		this.queueMetadataRefresh();
	}

	private async updateMetadataFromRecords(records: TaskDocumentRecord[]): Promise<void> {
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
