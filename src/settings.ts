import { Notice, PluginSettingTab, Setting, type App } from "obsidian";
import type TaskLitePlugin from "./main";
import { t, type I18nKey } from "./i18n";

export interface ToggleBehaviorSettings {
	cascadeFinish: boolean;
	cascadeCancel: boolean;
	cascadeUnfinish: boolean;
	cascadeUncancel: boolean;
	parentOnFinish: boolean;
	parentOnCancel: boolean;
	parentOnUnfinish: boolean;
	parentOnUncancel: boolean;
}

export interface TaskLiteSettings {
	setCreatedDate: boolean;
	setDoneDate: boolean;
	setCancelledDate: boolean;
	copySubtasksOnRecurrence: boolean;
	autoSuggestInEditor: boolean;
	toggleBehavior: ToggleBehaviorSettings;
}

export const DEFAULT_TOGGLE_BEHAVIOR: ToggleBehaviorSettings = {
	cascadeFinish: true,
	cascadeCancel: true,
	cascadeUnfinish: false,
	cascadeUncancel: true,
	parentOnFinish: true,
	parentOnCancel: true,
	parentOnUnfinish: true,
	parentOnUncancel: true,
};

export const DEFAULT_SETTINGS: TaskLiteSettings = {
	setCreatedDate: false,
	setDoneDate: true,
	setCancelledDate: true,
	copySubtasksOnRecurrence: true,
	autoSuggestInEditor: true,
	toggleBehavior: DEFAULT_TOGGLE_BEHAVIOR,
};

export class TaskLiteSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: TaskLitePlugin) {
		super(app, plugin);
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		this.addHeading(containerEl, "settings.heading.dates");
		this.addToggleSetting(containerEl, "settings.setDoneDate.name", "settings.setDoneDate.desc", this.plugin.settings.setDoneDate, async (v) => { this.plugin.settings.setDoneDate = v; await this.plugin.saveSettings(); });
		this.addToggleSetting(containerEl, "settings.setCancelledDate.name", "settings.setCancelledDate.desc", this.plugin.settings.setCancelledDate, async (v) => { this.plugin.settings.setCancelledDate = v; await this.plugin.saveSettings(); });
		this.addToggleSetting(containerEl, "settings.setCreatedDate.name", "settings.setCreatedDate.desc", this.plugin.settings.setCreatedDate, async (v) => { this.plugin.settings.setCreatedDate = v; await this.plugin.saveSettings(); });

		this.addHeading(containerEl, "settings.heading.recurrence");
		this.addToggleSetting(containerEl, "settings.copySubtasksOnRecurrence.name", "settings.copySubtasksOnRecurrence.desc", this.plugin.settings.copySubtasksOnRecurrence, async (v) => { this.plugin.settings.copySubtasksOnRecurrence = v; await this.plugin.saveSettings(); });

		this.addHeading(containerEl, "settings.heading.editor");
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

		this.addHeading(containerEl, "settings.heading.cascade");
		this.addToggleBehaviorSettings(containerEl, [
			{key: "cascadeFinish", nameKey: "settings.cascadeFinish.name", descKey: "settings.cascadeFinish.desc"},
			{key: "cascadeCancel", nameKey: "settings.cascadeCancel.name", descKey: "settings.cascadeCancel.desc"},
			{key: "cascadeUnfinish", nameKey: "settings.cascadeUnfinish.name", descKey: "settings.cascadeUnfinish.desc"},
			{key: "cascadeUncancel", nameKey: "settings.cascadeUncancel.name", descKey: "settings.cascadeUncancel.desc"},
		]);

		this.addHeading(containerEl, "settings.heading.parent");
		this.addToggleBehaviorSettings(containerEl, [
			{key: "parentOnFinish", nameKey: "settings.parentOnFinish.name", descKey: "settings.parentOnFinish.desc"},
			{key: "parentOnCancel", nameKey: "settings.parentOnCancel.name", descKey: "settings.parentOnCancel.desc"},
			{key: "parentOnUnfinish", nameKey: "settings.parentOnUnfinish.name", descKey: "settings.parentOnUnfinish.desc"},
			{key: "parentOnUncancel", nameKey: "settings.parentOnUncancel.name", descKey: "settings.parentOnUncancel.desc"},
		]);

	}

	private addHeading(containerEl: HTMLElement, key: I18nKey): void {
		new Setting(containerEl).setName(t(key)).setHeading();
	}

	private addToggleSetting(containerEl: HTMLElement, nameKey: I18nKey, descKey: I18nKey, value: boolean, onChange: (value: boolean) => Promise<void>): void {
		new Setting(containerEl)
			.setName(t(nameKey))
			.setDesc(t(descKey))
			.addToggle((toggle) =>
				toggle.setValue(value).onChange(async (v) => {
					await onChange(v);
				}),
			);
	}

	private addToggleBehaviorSettings(containerEl: HTMLElement, items: Array<{key: keyof ToggleBehaviorSettings; nameKey: I18nKey; descKey: I18nKey}>): void {
		for (const {key, nameKey, descKey} of items) {
			new Setting(containerEl)
				.setName(t(nameKey))
				.setDesc(t(descKey))
				.addToggle((toggle) =>
					toggle.setValue(this.plugin.settings.toggleBehavior[key]).onChange(async (value) => {
						this.plugin.settings.toggleBehavior[key] = value;
						await this.plugin.saveSettings();
					}),
				);
		}
	}
}

export function mergeSettings(loaded: Partial<TaskLiteSettings> | null | undefined): TaskLiteSettings {
	const toggleBehavior: ToggleBehaviorSettings = { ...DEFAULT_TOGGLE_BEHAVIOR, ...loaded?.toggleBehavior };
	return {
		...DEFAULT_SETTINGS,
		...loaded,
		toggleBehavior,
	};
}
