import { MarkdownView, Notice, Plugin, type Editor } from "obsidian";
import { StatusRegistry } from "./model/status";
import { toggleEditorTask } from "./editor/apply";
import { InlineTaskRenderer } from "./rendering/inlineRenderer";
import { createLivePreviewExtension } from "./rendering/livePreview";
import { TaskLiteEmojiSuggest } from "./suggest/emojiSuggest";
import {
	DEFAULT_SETTINGS,
	TaskLiteSettingTab,
	importTasksStatusSettings,
	mergeSettings,
	type TaskLiteSettings,
} from "./settings";

export default class TaskLitePlugin extends Plugin {
	settings: TaskLiteSettings = DEFAULT_SETTINGS;
	readonly statusRegistry = new StatusRegistry(DEFAULT_SETTINGS.statusSettings);

	async onload(): Promise<void> {
		await this.loadSettings();
		this.statusRegistry.set(this.settings.statusSettings);

		this.addCommand({
			id: "toggle-task",
			name: "Toggle task",
			editorCheckCallback: (checking: boolean, editor: Editor, view) => {
				if (!(view instanceof MarkdownView)) return false;
				if (checking) return true;
				const path = view.file?.path;
				if (!path) return false;
				return toggleEditorTask({
					editor,
					app: this.app,
					path,
					registry: this.statusRegistry,
					settings: this.settings,
				});
			},
		});

		this.addCommand({
			id: "import-tasks-status-settings",
			name: "Import status settings",
			callback: async () => {
				const imported = await this.importTasksStatusSettings();
				new Notice(imported ? "Imported status settings." : "No status settings found.");
			},
		});

		new InlineTaskRenderer(this, this.app, this.statusRegistry, () => this.settings).register();
		this.registerEditorExtension(createLivePreviewExtension(this.app, this.statusRegistry, () => this.settings));
		this.registerEditorSuggest(new TaskLiteEmojiSuggest(this));
		this.addSettingTab(new TaskLiteSettingTab(this.app, this));
	}

	async loadSettings(): Promise<void> {
		this.settings = mergeSettings((await this.loadData()) as Partial<TaskLiteSettings> | null);
	}

	async saveSettings(): Promise<void> {
		this.statusRegistry.set(this.settings.statusSettings);
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
