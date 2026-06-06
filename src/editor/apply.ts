import type { App, CachedMetadata, Editor } from "obsidian";
import { Notice, TFile } from "obsidian";
import type { StatusRegistry } from "../model/status";
import type { TaskDocumentStore } from "../model/taskDocumentStore";
import type { TaskLiteSettings } from "../settings";
import { cancelTaskAtLine, clickTaskCheckboxAtLine, rightClickTaskCheckboxAtLine, uncancelTaskAtLine, type ToggleResult } from "./toggle";
import { findOpenMarkdownEditor } from "./editorUtils";

type EditorTaskMutation = (input: {
	lines: string[];
	lineNumber: number;
	metadata: CachedMetadata | null;
	app: App;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
}) => ToggleResult | null;

export function toggleEditorTask({
	editor,
	app,
	path,
	registry,
	settings,
	documentStore,
}: {
	editor: Editor;
	app: App;
	path: string;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
	documentStore?: TaskDocumentStore;
}): boolean {
	return mutateEditorTask({editor, app, path, registry, settings, documentStore, mutate: clickTaskCheckboxAtLine});
}

export function cancelEditorTask({
	editor,
	app,
	path,
	registry,
	settings,
	documentStore,
}: {
	editor: Editor;
	app: App;
	path: string;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
	documentStore?: TaskDocumentStore;
}): boolean {
	return mutateEditorTask({editor, app, path, registry, settings, documentStore, mutate: cancelTaskAtLine});
}

export function uncancelEditorTask({
	editor,
	app,
	path,
	registry,
	settings,
	documentStore,
}: {
	editor: Editor;
	app: App;
	path: string;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
	documentStore?: TaskDocumentStore;
}): boolean {
	return mutateEditorTask({editor, app, path, registry, settings, documentStore, mutate: uncancelTaskAtLine});
}

export function toggleEditorTaskCancellation({
	editor,
	app,
	path,
	registry,
	settings,
	documentStore,
}: {
	editor: Editor;
	app: App;
	path: string;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
	documentStore?: TaskDocumentStore;
}): boolean {
	return mutateEditorTask({editor, app, path, registry, settings, documentStore, mutate: rightClickTaskCheckboxAtLine});
}


async function mutateFileTask({
	app,
	path,
	lineNumber,
	registry,
	settings,
	documentStore,
	mutate,
}: {
	app: App;
	path: string;
	lineNumber: number;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
	documentStore?: TaskDocumentStore;
	mutate: EditorTaskMutation;
}): Promise<boolean> {
	const openEditor = findOpenMarkdownEditor(app, path);
	if (openEditor) {
		return mutateOpenEditorTask({editor: openEditor, app, path, lineNumber, registry, settings, documentStore, mutate});
	}

	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) return false;
	const content = await app.vault.read(file);
	const lines = content.split("\n");
	const result = mutate({lines, lineNumber, metadata: app.metadataCache.getFileCache(file), app, registry, settings});
	if (!result) return false;

	lines.splice(result.fromLine, result.toLine - result.fromLine + 1, ...result.replacement);
	const nextContent = lines.join("\n");
	await app.vault.modify(file, nextContent);
	// Keep documentStore in sync so subsequent reads see up-to-date content
	await documentStore?.replaceDocumentContent(file, nextContent);
	if (result.warning) new Notice(result.warning);
	return true;
}

function mutateOpenEditorTask({
	editor,
	app,
	path,
	lineNumber,
	registry,
	settings,
	documentStore,
	mutate,
}: {
	editor: Editor;
	app: App;
	path: string;
	lineNumber: number;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
	documentStore?: TaskDocumentStore;
	mutate: EditorTaskMutation;
}): boolean {
	const cursor = editor.getCursor();
	const lines = Array.from({length: editor.lineCount()}, (_value, index) => editor.getLine(index));
	const result = mutate({lines, lineNumber, metadata: getFileCache(app, path), app, registry, settings});
	if (!result) return false;

	const from = {line: result.fromLine, ch: 0};
	const lastLine = editor.getLine(result.toLine);
	const to = {line: result.toLine, ch: lastLine.length};
	editor.replaceRange(result.replacement.join("\n"), from, to);
	refreshOpenEditorDocument(app, path, editor, documentStore);
	const nextCursorLine = Math.min(
		Math.max(cursor.line + (result.replacement.length - (result.toLine - result.fromLine + 1)), 0),
		Math.max(editor.lineCount() - 1, 0),
	);
	const nextCursorCh = cursor.line === lineNumber ? Math.min(cursor.ch, result.replacement[0]?.length ?? 0) : cursor.ch;
	editor.setCursor({line: nextCursorLine, ch: nextCursorCh});
	if (result.warning) new Notice(result.warning);
	return true;
}

function mutateEditorTask({
	editor,
	app,
	path,
	registry,
	settings,
	documentStore,
	mutate,
}: {
	editor: Editor;
	app: App;
	path: string;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
	documentStore?: TaskDocumentStore;
	mutate: EditorTaskMutation;
}): boolean {
	const cursor = editor.getCursor();
	const lines = Array.from({length: editor.lineCount()}, (_value, index) => editor.getLine(index));
	const metadata = getFileCache(app, path);
	const result = mutate({lines, lineNumber: cursor.line, metadata, app, registry, settings});
	if (!result) return false;

	const from = {line: result.fromLine, ch: 0};
	const lastLine = editor.getLine(result.toLine);
	const to = {line: result.toLine, ch: lastLine.length};
	editor.replaceRange(result.replacement.join("\n"), from, to);
	refreshOpenEditorDocument(app, path, editor, documentStore);
	editor.setCursor({line: result.fromLine, ch: Math.min(cursor.ch, result.replacement[0]?.length ?? 0)});
	if (result.warning) new Notice(result.warning);
	return true;
}

function refreshOpenEditorDocument(app: App, path: string, editor: Editor, documentStore: TaskDocumentStore | undefined): void {
	if (!documentStore) return;
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) return;
	void documentStore.replaceDocumentContent(file, editor.getValue());
}

function getFileCache(app: App, path: string): CachedMetadata | null {
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) return null;
	return app.metadataCache.getFileCache(file);
}


