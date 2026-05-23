import { Notice, PluginSettingTab, Setting, type App } from "obsidian";
import type TaskLitePlugin from "./main";
import { DEFAULT_STATUS_SETTINGS, normalizeStatusSettings, type StatusSettings } from "./model/status";
import { t } from "./i18n";

export interface TaskLiteSettings {
	setCreatedDate: boolean;
	setDoneDate: boolean;
	setCancelledDate: boolean;
	copySubtasksOnRecurrence: boolean;
	autoSuggestInEditor: boolean;
	statusSettings: StatusSettings;
}

export const DEFAULT_SETTINGS: TaskLiteSettings = {
	setCreatedDate: false,
	setDoneDate: true,
	setCancelledDate: true,
	copySubtasksOnRecurrence: true,
	autoSuggestInEditor: true,
	statusSettings: DEFAULT_STATUS_SETTINGS,
};

export class TaskLiteSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: TaskLitePlugin) {
		super(app, plugin);
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName(t("settings.setDoneDate.name"))
			.setDesc(t("settings.setDoneDate.desc"))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.setDoneDate).onChange(async (value) => {
					this.plugin.settings.setDoneDate = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName(t("settings.setCancelledDate.name"))
			.setDesc(t("settings.setCancelledDate.desc"))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.setCancelledDate).onChange(async (value) => {
					this.plugin.settings.setCancelledDate = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName(t("settings.setCreatedDate.name"))
			.setDesc(t("settings.setCreatedDate.desc"))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.setCreatedDate).onChange(async (value) => {
					this.plugin.settings.setCreatedDate = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName(t("settings.copySubtasksOnRecurrence.name"))
			.setDesc(t("settings.copySubtasksOnRecurrence.desc"))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.copySubtasksOnRecurrence).onChange(async (value) => {
					this.plugin.settings.copySubtasksOnRecurrence = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName(t("settings.emojiSuggestions.name"))
			.setDesc(t("settings.emojiSuggestions.desc"))
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoSuggestInEditor).onChange(async (value) => {
					this.plugin.settings.autoSuggestInEditor = value;
					await this.plugin.saveSettings();
					new Notice(t("notice.reloadForSuggestions"));
				}),
			);

		new Setting(containerEl)
			.setName(t("settings.importStatuses.name"))
			.setDesc(t("settings.importStatuses.desc"))
			.addButton((button) =>
				button.setButtonText(t("settings.importStatuses.button")).onClick(async () => {
					const imported = await this.plugin.importTasksStatusSettings();
					new Notice(imported ? t("notice.importedStatusSettings") : t("notice.noStatusSettings"));
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

export function mergeSettings(loaded: Partial<TaskLiteSettings> | null | undefined): TaskLiteSettings {
	const statusSettings = normalizeStatusSettings(loaded?.statusSettings) ?? DEFAULT_STATUS_SETTINGS;
	return {
		...DEFAULT_SETTINGS,
		...loaded,
		statusSettings,
	};
}
