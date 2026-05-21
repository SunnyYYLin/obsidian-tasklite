import { MarkdownView, Notice, Plugin, type Editor } from "obsidian";
import { registerTasksApiShim } from "./compat/tasksApi";
import { StatusRegistry } from "./model/status";
import { toggleEditorTask } from "./editor/apply";
import { InlineTaskRenderer } from "./rendering/inlineRenderer";
import { createLivePreviewExtension } from "./rendering/livePreview";
import { TaskLiteEmojiSuggest } from "./suggest/emojiSuggest";
import { openTaskLineModal } from "./ui/taskLineModal";
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
	private unregisterTasksApiShim: (() => void) | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.statusRegistry.set(this.settings.statusSettings);
		this.unregisterTasksApiShim = registerTasksApiShim(this);

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
			id: "create-task",
			name: "Create task",
			editorCallback: (editor: Editor) => {
				void this.createTaskInEditor(editor);
			},
		});

		this.addCommand({
			id: "edit-task",
			name: "Edit task",
			editorCheckCallback: (checking: boolean, editor: Editor, view) => {
				if (!(view instanceof MarkdownView)) return false;
				if (checking) return true;
				void this.editTaskInEditor(editor);
				return true;
			},
		});

		this.addCommand({
			id: "create-or-edit-task",
			name: "Create or edit task",
			editorCallback: (editor: Editor) => {
				void this.createOrEditTaskInEditor(editor);
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

	onunload(): void {
		this.unregisterTasksApiShim?.();
		this.unregisterTasksApiShim = null;
	}

	private async createTaskInEditor(editor: Editor): Promise<void> {
		const line = await openTaskLineModal({
			app: this.app,
			title: "Create task",
			initialLine: "",
			registry: this.statusRegistry,
			settings: this.settings,
		});
		if (!line) return;

		const cursor = editor.getCursor();
		const currentLine = editor.getLine(cursor.line);
		if (currentLine.trim() === "") {
			editor.replaceRange(line, {line: cursor.line, ch: 0}, {line: cursor.line, ch: currentLine.length});
			editor.setCursor({line: cursor.line, ch: line.length});
			return;
		}

		editor.replaceRange(`\n${line}`, {line: cursor.line, ch: currentLine.length});
		editor.setCursor({line: cursor.line + 1, ch: line.length});
	}

	private async editTaskInEditor(editor: Editor): Promise<void> {
		const cursor = editor.getCursor();
		const currentLine = editor.getLine(cursor.line);
		const line = await openTaskLineModal({
			app: this.app,
			title: "Edit task",
			initialLine: currentLine,
			registry: this.statusRegistry,
			settings: this.settings,
		});
		if (!line) return;

		editor.replaceRange(line, {line: cursor.line, ch: 0}, {line: cursor.line, ch: currentLine.length});
		editor.setCursor({line: cursor.line, ch: Math.min(cursor.ch, line.length)});
	}

	private async createOrEditTaskInEditor(editor: Editor): Promise<void> {
		const cursor = editor.getCursor();
		const currentLine = editor.getLine(cursor.line);
		if (currentLine.trim() === "") {
			await this.createTaskInEditor(editor);
			return;
		}
		await this.editTaskInEditor(editor);
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
