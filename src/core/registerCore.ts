import { MarkdownView, Notice, TFile, type Editor } from "obsidian";
import type TaskLitePlugin from "../main";
import { normalizeLineIndentation, serializeTaskLine, parseLineWithStatus } from "../model/format";
import { generateSemanticId } from "../model/taskSemanticId";
import { cancelEditorTask, toggleEditorTask, toggleEditorTaskCancellation, uncancelEditorTask } from "../editor/apply";
import { ExternalTaskReconciler } from "../editor/externalReconcile";
import { createLivePreviewExtension } from "../rendering/livePreview";
import { TaskLiteEmojiSuggest } from "../suggest/emojiSuggest";
import { TaskLiteSettingTab } from "../settings";
import { t } from "../i18n";
import { getVaultIndentConfig } from "../editor/editorUtils";

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

				const { useTab, tabSize } = getVaultIndentConfig(plugin.app);

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

	plugin.addCommand({
		id: "generate-semantic-id",
		name: t("command.generateSemanticId"),
		editorCheckCallback: (checking: boolean, editor: Editor, view) => {
			if (!(view instanceof MarkdownView)) return false;
			if (checking) return true;
			const cursor = editor.getCursor();
			const line = editor.getLine(cursor.line);
			const registry = plugin.statusRegistry;
			const parsed = parseLineWithStatus(line, registry);
			if (!parsed) {
				new Notice(t("notice.notATaskLine"));
				return true;
			}
			if (parsed.data.id) {
				new Notice(t("notice.taskIdAlreadyExists"));
				return true;
			}
			const existingIds = new Set<string>();
			for (const r of plugin.documentStore.listCachedRecords()) {
				if (r.task.id) {
					existingIds.add(r.task.id);
				}
			}
			const semanticId = generateSemanticId(parsed.data.description, {
				isRecurring: !!parsed.data.recurrence,
				dueDate: parsed.data.dates.due,
				existingIds,
			});
			parsed.data.id = semanticId;
			const indent = line.match(/^([\s\t>]*)/)?.[0] ?? "";
			const newLine = serializeTaskLine(parsed, indent, registry);
			editor.setLine(cursor.line, newLine);
			new Notice(t("notice.taskIdGenerated").replace("{id}", semanticId));
			return true;
		},
	});

	plugin.addCommand({
		id: "rebuild-cache",
		name: t("command.rebuildCache"),
		callback: () => {
			(async () => {
				plugin.documentStore.invalidateAll();
				await plugin.updateAssigneesFromVault();
				new Notice(t("notice.cacheRebuilt"));
			})().catch((err) => {
				console.error(err);
			});
		},
	});


	new ExternalTaskReconciler(plugin, plugin.app, plugin.statusRegistry, () => plugin.settings, plugin.documentStore).register();
	plugin.registerEditorExtension(createLivePreviewExtension(plugin.app, plugin.statusRegistry, () => plugin.settings, plugin.documentStore));
	plugin.registerEditorSuggest(new TaskLiteEmojiSuggest(plugin));
	plugin.addSettingTab(new TaskLiteSettingTab(plugin.app, plugin));
}

