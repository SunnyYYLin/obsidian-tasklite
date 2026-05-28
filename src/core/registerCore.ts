import { MarkdownView, Notice, type Editor } from "obsidian";
import type TaskLitePlugin from "../main";
import { cancelEditorTask, toggleEditorTask, toggleEditorTaskCancellation, uncancelEditorTask } from "../editor/apply";
import { ExternalTaskReconciler } from "../editor/externalReconcile";
import { createLivePreviewExtension } from "../rendering/livePreview";
import { TaskLiteEmojiSuggest } from "../suggest/emojiSuggest";
import { openTaskLineModal } from "../ui/taskLineModal";
import { TaskLiteSettingTab } from "../settings";
import { t } from "../i18n";

export function registerTaskLiteCore(plugin: TaskLitePlugin): void {
	plugin.addCommand({
		id: "toggle-task",
		name: t("command.toggleTask"),
		editorCheckCallback: (checking: boolean, editor: Editor, view) => {
			if (!(view instanceof MarkdownView)) return false;
			if (checking) return true;
			const path = view.file?.path;
			if (!path) return false;
			return toggleEditorTask({
				editor,
				app: plugin.app,
				path,
				registry: plugin.statusRegistry,
				settings: plugin.settings,
				documentStore: plugin.documentStore,
			});
		},
	});

	plugin.addCommand({
		id: "toggle-task-cancellation",
		name: t("command.toggleTaskCancellation"),
		editorCheckCallback: (checking: boolean, editor: Editor, view) => {
			if (!(view instanceof MarkdownView)) return false;
			if (checking) return true;
			const path = view.file?.path;
			if (!path) return false;
			return toggleEditorTaskCancellation({
				editor,
				app: plugin.app,
				path,
				registry: plugin.statusRegistry,
				settings: plugin.settings,
				documentStore: plugin.documentStore,
			});
		},
	});

	plugin.addCommand({
		id: "cancel-task",
		name: t("command.cancelTask"),
		editorCheckCallback: (checking: boolean, editor: Editor, view) => {
			if (!(view instanceof MarkdownView)) return false;
			if (checking) return true;
			const path = view.file?.path;
			if (!path) return false;
			return cancelEditorTask({
				editor,
				app: plugin.app,
				path,
				registry: plugin.statusRegistry,
				settings: plugin.settings,
				documentStore: plugin.documentStore,
			});
		},
	});

	plugin.addCommand({
		id: "uncancel-task",
		name: t("command.uncancelTask"),
		editorCheckCallback: (checking: boolean, editor: Editor, view) => {
			if (!(view instanceof MarkdownView)) return false;
			if (checking) return true;
			const path = view.file?.path;
			if (!path) return false;
			return uncancelEditorTask({
				editor,
				app: plugin.app,
				path,
				registry: plugin.statusRegistry,
				settings: plugin.settings,
				documentStore: plugin.documentStore,
			});
		},
	});

	plugin.addCommand({
		id: "create-task",
		name: t("command.createTask"),
		editorCallback: (editor: Editor) => {
			void createTaskInEditor(plugin, editor);
		},
	});

	plugin.addCommand({
		id: "edit-task",
		name: t("command.editTask"),
		editorCheckCallback: (checking: boolean, editor: Editor, view) => {
			if (!(view instanceof MarkdownView)) return false;
			if (checking) return true;
			void editTaskInEditor(plugin, editor);
			return true;
		},
	});

	plugin.addCommand({
		id: "create-or-edit-task",
		name: t("command.createOrEditTask"),
		editorCallback: (editor: Editor) => {
			void createOrEditTaskInEditor(plugin, editor);
		},
	});

	plugin.addCommand({
		id: "import-tasks-status-settings",
		name: t("command.importStatusSettings"),
		callback: async () => {
			const imported = await plugin.importTasksStatusSettings();
			new Notice(imported ? t("notice.importedStatusSettings") : t("notice.noStatusSettings"));
		},
	});

	new ExternalTaskReconciler(plugin, plugin.app, plugin.statusRegistry, () => plugin.settings, plugin.documentStore).register();
	plugin.registerEditorExtension(createLivePreviewExtension(plugin.app, plugin.statusRegistry, () => plugin.settings, plugin.documentStore));
	plugin.registerEditorSuggest(new TaskLiteEmojiSuggest(plugin));
	plugin.addSettingTab(new TaskLiteSettingTab(plugin.app, plugin));
}

async function createTaskInEditor(plugin: TaskLitePlugin, editor: Editor): Promise<void> {
	const line = await openTaskLineModal({
		app: plugin.app,
		title: t("command.createTask"),
		initialLine: "",
		registry: plugin.statusRegistry,
		settings: plugin.settings,
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

async function editTaskInEditor(plugin: TaskLitePlugin, editor: Editor): Promise<void> {
	const cursor = editor.getCursor();
	const currentLine = editor.getLine(cursor.line);
	const line = await openTaskLineModal({
		app: plugin.app,
		title: t("command.editTask"),
		initialLine: currentLine,
		registry: plugin.statusRegistry,
		settings: plugin.settings,
	});
	if (!line) return;

	editor.replaceRange(line, {line: cursor.line, ch: 0}, {line: cursor.line, ch: currentLine.length});
	editor.setCursor({line: cursor.line, ch: Math.min(cursor.ch, line.length)});
}

async function createOrEditTaskInEditor(plugin: TaskLitePlugin, editor: Editor): Promise<void> {
	const cursor = editor.getCursor();
	const currentLine = editor.getLine(cursor.line);
	if (currentLine.trim() === "") {
		await createTaskInEditor(plugin, editor);
		return;
	}
	await editTaskInEditor(plugin, editor);
}
