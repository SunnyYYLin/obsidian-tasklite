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

		new Setting(containerEl)
			.setName("Set done date")
			.setDesc("When a task enters done, add the done date.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.setDoneDate).onChange(async (value) => {
					this.plugin.settings.setDoneDate = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Set cancelled date")
			.setDesc("When a task enters cancelled, add the cancelled date.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.setCancelledDate).onChange(async (value) => {
					this.plugin.settings.setCancelledDate = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Set created date")
			.setDesc("When creating the next recurring task, add the created date.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.setCreatedDate).onChange(async (value) => {
					this.plugin.settings.setCreatedDate = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Copy subtasks on recurrence")
			.setDesc("When a recurring parent task completes, copy its descendant list items into the next occurrence.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.copySubtasksOnRecurrence).onChange(async (value) => {
					this.plugin.settings.copySubtasksOnRecurrence = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Emoji suggestions")
			.setDesc("Show emoji field suggestions while editing task lines.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoSuggestInEditor).onChange(async (value) => {
					this.plugin.settings.autoSuggestInEditor = value;
					await this.plugin.saveSettings();
					new Notice("Reload the app to fully refresh editor suggestions.");
				}),
			);

		new Setting(containerEl)
			.setName("Import task statuses")
			.setDesc("Best-effort import from the vault config folder.")
			.addButton((button) =>
				button.setButtonText("Import statuses").onClick(async () => {
					const imported = await this.plugin.importTasksStatusSettings();
					new Notice(imported ? "Imported status settings." : "No status settings found.");
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
