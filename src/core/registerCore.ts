import { MarkdownView, Notice, TFile, type Editor } from "obsidian";
import type TaskLitePlugin from "../main";
import { normalizeLineIndentation } from "../model/format";
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
		id: "normalize-indentation",
		name: t("command.normalizeIndentation"),
		checkCallback: (checking: boolean) => {
			const activeFile = plugin.app.workspace.getActiveFile();
			if (!activeFile) return false;
			if (checking) return true;

			(async () => {
				const content = await plugin.app.vault.read(activeFile);
				const lines = content.length > 0 ? content.split("\n") : [];

				const vaultConfig = (plugin.app.vault as any).config || {};
				const useTab = vaultConfig.useTab ?? true;
				const tabSize = vaultConfig.tabSize ?? 4;

				let changed = false;
				const newLines = lines.map((line) => {
					const newLine = normalizeLineIndentation(line, useTab, tabSize);
					if (newLine !== line) {
						changed = true;
					}
					return newLine;
				});

				if (changed) {
					const newContent = newLines.join("\n");
					await plugin.app.vault.modify(activeFile, newContent);
					await plugin.documentStore.replaceDocumentContent(activeFile, newContent);
				}
				new Notice(t("notice.normalizedIndents"));
			})().catch((err) => {
				console.error(err);
			});
			return true;
		},
	});


	new ExternalTaskReconciler(plugin, plugin.app, plugin.statusRegistry, () => plugin.settings, plugin.documentStore).register();
	plugin.registerEditorExtension(createLivePreviewExtension(plugin.app, plugin.statusRegistry, () => plugin.settings, plugin.documentStore));
	plugin.registerEditorSuggest(new TaskLiteEmojiSuggest(plugin));
	plugin.addSettingTab(new TaskLiteSettingTab(plugin.app, plugin));
}

