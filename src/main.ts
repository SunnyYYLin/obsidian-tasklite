import { MarkdownView, Notice, Plugin, type Editor } from "obsidian";
import { StatusRegistry } from "./model/status";
import { toggleEditorTask } from "./editor/apply";
import { InlineTaskRenderer } from "./rendering/inlineRenderer";
import { createLivePreviewExtension } from "./rendering/livePreview";
import { TasksLiteEmojiSuggest } from "./suggest/emojiSuggest";
import {
	DEFAULT_SETTINGS,
	TasksLiteSettingTab,
	importTasksStatusSettings,
	mergeSettings,
	type TasksLiteSettings,
} from "./settings";

export default class TasksLitePlugin extends Plugin {
	settings: TasksLiteSettings = DEFAULT_SETTINGS;
	readonly statusRegistry = new StatusRegistry(DEFAULT_SETTINGS.statusSettings);

	async onload(): Promise<void> {
		await this.loadSettings();
		this.statusRegistry.set(this.settings.statusSettings);

		this.addCommand({
			id: "toggle-taskslite-task",
			name: "Toggle TasksLite task / 切换 TasksLite 任务",
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
			name: "Import status settings from Tasks / 从 Tasks 导入状态",
			callback: async () => {
				const imported = await this.importTasksStatusSettings();
				new Notice(imported ? "TasksLite: imported Tasks status settings." : "TasksLite: no Tasks status settings found.");
			},
		});

		new InlineTaskRenderer(this, this.app, this.statusRegistry, () => this.settings).register();
		this.registerEditorExtension(createLivePreviewExtension(this.app, this.statusRegistry, () => this.settings));
		this.registerEditorSuggest(new TasksLiteEmojiSuggest(this));
		this.addSettingTab(new TasksLiteSettingTab(this.app, this));
	}

	async loadSettings(): Promise<void> {
		this.settings = mergeSettings((await this.loadData()) as Partial<TasksLiteSettings> | null);
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
			console.warn("TasksLite failed to import Tasks settings", error);
			return false;
		}
	}
}
