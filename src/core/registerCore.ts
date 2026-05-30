import { MarkdownView, Notice, TFile, type Editor } from "obsidian";
import type TaskLitePlugin from "../main";
import { cancelEditorTask, toggleEditorTask, toggleEditorTaskCancellation, uncancelEditorTask } from "../editor/apply";
import { ExternalTaskReconciler } from "../editor/externalReconcile";
import { createLivePreviewExtension } from "../rendering/livePreview";
import { TaskLiteEmojiSuggest } from "../suggest/emojiSuggest";
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

