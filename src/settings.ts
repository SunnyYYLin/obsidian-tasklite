import { Notice, PluginSettingTab, Setting, type App } from "obsidian";
import type TasksLitePlugin from "./main";
import { DEFAULT_STATUS_SETTINGS, normalizeStatusSettings, type StatusSettings } from "./model/status";

export interface TasksLiteSettings {
	setCreatedDate: boolean;
	setDoneDate: boolean;
	setCancelledDate: boolean;
	copySubtasksOnRecurrence: boolean;
	autoSuggestInEditor: boolean;
	statusSettings: StatusSettings;
}

export const DEFAULT_SETTINGS: TasksLiteSettings = {
	setCreatedDate: false,
	setDoneDate: true,
	setCancelledDate: true,
	copySubtasksOnRecurrence: true,
	autoSuggestInEditor: true,
	statusSettings: DEFAULT_STATUS_SETTINGS,
};

export class TasksLiteSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: TasksLitePlugin) {
		super(app, plugin);
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		containerEl.createEl("h2", {text: "TasksLite 设置 / Settings"});

		new Setting(containerEl)
			.setName("完成时写入完成日期 / Set done date")
			.setDesc("When a task enters Done, add ✅ YYYY-MM-DD.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.setDoneDate).onChange(async (value) => {
					this.plugin.settings.setDoneDate = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("取消时写入取消日期 / Set cancelled date")
			.setDesc("When a task enters Cancelled, add ❌ YYYY-MM-DD.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.setCancelledDate).onChange(async (value) => {
					this.plugin.settings.setCancelledDate = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("新循环任务写入创建日期 / Set created date")
			.setDesc("When creating the next recurring task, add ➕ YYYY-MM-DD.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.setCreatedDate).onChange(async (value) => {
					this.plugin.settings.setCreatedDate = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("循环时复制子任务 / Copy subtasks on recurrence")
			.setDesc("When a recurring parent task completes, copy its descendant list items into the next occurrence.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.copySubtasksOnRecurrence).onChange(async (value) => {
					this.plugin.settings.copySubtasksOnRecurrence = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Emoji 输入辅助 / Emoji suggestions")
			.setDesc("Show Tasks-compatible emoji field suggestions while editing task lines.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoSuggestInEditor).onChange(async (value) => {
					this.plugin.settings.autoSuggestInEditor = value;
					await this.plugin.saveSettings();
					new Notice("Reload Obsidian to fully refresh editor suggestions.");
				}),
			);

		new Setting(containerEl)
			.setName("导入 Tasks 状态 / Import Tasks statuses")
			.setDesc("Best-effort import from .obsidian/plugins/obsidian-tasks-plugin/data.json in this vault.")
			.addButton((button) =>
				button.setButtonText("Import").onClick(async () => {
					const imported = await this.plugin.importTasksStatusSettings();
					new Notice(imported ? "TasksLite: imported Tasks status settings." : "TasksLite: no Tasks status settings found.");
					this.display();
				}),
			);
	}
}

export async function importTasksStatusSettings(app: App): Promise<StatusSettings | null> {
	const configDir = app.vault.configDir;
	const file = app.vault.getAbstractFileByPath(`${configDir}/plugins/obsidian-tasks-plugin/data.json`);
	if (!file || !("extension" in file)) return null;
	const raw = await app.vault.adapter.read(file.path);
	const parsed = JSON.parse(raw) as {statusSettings?: unknown};
	return normalizeStatusSettings(parsed.statusSettings);
}

export function mergeSettings(loaded: Partial<TasksLiteSettings> | null | undefined): TasksLiteSettings {
	const statusSettings = normalizeStatusSettings(loaded?.statusSettings) ?? DEFAULT_STATUS_SETTINGS;
	return {
		...DEFAULT_SETTINGS,
		...loaded,
		statusSettings,
	};
}
