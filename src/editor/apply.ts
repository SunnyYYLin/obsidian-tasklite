import type { App, CachedMetadata, Editor } from "obsidian";
import { Notice, TFile } from "obsidian";
import type { StatusRegistry } from "../model/status";
import type { TaskLiteSettings } from "../settings";
import { cancelTaskAtLine, clickTaskCheckboxAtLine, rightClickTaskCheckboxAtLine, uncancelTaskAtLine, type ToggleResult } from "./toggle";

type EditorTaskMutation = (input: {
	lines: string[];
	lineNumber: number;
	metadata: CachedMetadata | null;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
}) => ToggleResult | null;

export function toggleEditorTask({
	editor,
	app,
	path,
	registry,
	settings,
}: {
	editor: Editor;
	app: App;
	path: string;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
}): boolean {
	return mutateEditorTask({editor, app, path, registry, settings, mutate: clickTaskCheckboxAtLine});
}

export function cancelEditorTask({
	editor,
	app,
	path,
	registry,
	settings,
}: {
	editor: Editor;
	app: App;
	path: string;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
}): boolean {
	return mutateEditorTask({editor, app, path, registry, settings, mutate: cancelTaskAtLine});
}

export function uncancelEditorTask({
	editor,
	app,
	path,
	registry,
	settings,
}: {
	editor: Editor;
	app: App;
	path: string;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
}): boolean {
	return mutateEditorTask({editor, app, path, registry, settings, mutate: uncancelTaskAtLine});
}

export function toggleEditorTaskCancellation({
	editor,
	app,
	path,
	registry,
	settings,
}: {
	editor: Editor;
	app: App;
	path: string;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
}): boolean {
	const line = editor.getLine(editor.getCursor().line);
	const statusSymbol = line.match(/\[(.)\]/u)?.[1] ?? "";
	const mutate = registry.get(statusSymbol).type === "CANCELLED" ? uncancelTaskAtLine : cancelTaskAtLine;
	return mutateEditorTask({editor, app, path, registry, settings, mutate});
}

export async function toggleFileTask({
	app,
	path,
	lineNumber,
	registry,
	settings,
}: {
	app: App;
	path: string;
	lineNumber: number;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
}): Promise<boolean> {
	return mutateFileTask({app, path, lineNumber, registry, settings, mutate: clickTaskCheckboxAtLine});
}

export async function toggleFileTaskCancellation({
	app,
	path,
	lineNumber,
	registry,
	settings,
}: {
	app: App;
	path: string;
	lineNumber: number;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
}): Promise<boolean> {
	return mutateFileTask({app, path, lineNumber, registry, settings, mutate: rightClickTaskCheckboxAtLine});
}

async function mutateFileTask({
	app,
	path,
	lineNumber,
	registry,
	settings,
	mutate,
}: {
	app: App;
	path: string;
	lineNumber: number;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
	mutate: EditorTaskMutation;
}): Promise<boolean> {
	const openEditor = findOpenMarkdownEditor(app, path);
	if (openEditor) {
		return mutateOpenEditorTask({editor: openEditor, app, path, lineNumber, registry, settings, mutate});
	}

	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) return false;
	const content = await app.vault.read(file);
	const lines = content.split("\n");
	const result = mutate({lines, lineNumber, metadata: app.metadataCache.getFileCache(file), registry, settings});
	if (!result) return false;

	lines.splice(result.fromLine, result.toLine - result.fromLine + 1, ...result.replacement);
	await app.vault.modify(file, lines.join("\n"));
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
	mutate,
}: {
	editor: Editor;
	app: App;
	path: string;
	lineNumber: number;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
	mutate: EditorTaskMutation;
}): boolean {
	const cursor = editor.getCursor();
	const lines = Array.from({length: editor.lineCount()}, (_value, index) => editor.getLine(index));
	const result = mutate({lines, lineNumber, metadata: getFileCache(app, path), registry, settings});
	if (!result) return false;

	const from = {line: result.fromLine, ch: 0};
	const lastLine = editor.getLine(result.toLine);
	const to = {line: result.toLine, ch: lastLine.length};
	editor.replaceRange(result.replacement.join("\n"), from, to);
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
	mutate,
}: {
	editor: Editor;
	app: App;
	path: string;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
	mutate: EditorTaskMutation;
}): boolean {
	const cursor = editor.getCursor();
	const lines = Array.from({length: editor.lineCount()}, (_value, index) => editor.getLine(index));
	const metadata = getFileCache(app, path);
	const result = mutate({lines, lineNumber: cursor.line, metadata, registry, settings});
	if (!result) return false;

	const from = {line: result.fromLine, ch: 0};
	const lastLine = editor.getLine(result.toLine);
	const to = {line: result.toLine, ch: lastLine.length};
	editor.replaceRange(result.replacement.join("\n"), from, to);
	editor.setCursor({line: result.fromLine, ch: Math.min(cursor.ch, result.replacement[0]?.length ?? 0)});
	if (result.warning) new Notice(result.warning);
	return true;
}

function getFileCache(app: App, path: string): CachedMetadata | null {
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) return null;
	return app.metadataCache.getFileCache(file);
}

function findOpenMarkdownEditor(app: App, path: string): Editor | null {
	const workspace = app.workspace as {
		activeEditor?: unknown;
		getLeavesOfType?: (viewType: string) => Array<{view: unknown}>;
	};
	const activeEditor = getEditorForPath(workspace.activeEditor, path);
	if (activeEditor) return activeEditor;

	for (const leaf of workspace.getLeavesOfType?.("markdown") ?? []) {
		const editor = getEditorForPath(leaf.view, path);
		if (editor) return editor;
	}
	return null;
}

function getEditorForPath(value: unknown, path: string): Editor | null {
	const info = value as {file?: TFile | null; editor?: Editor} | null | undefined;
	if (info?.file?.path === path && info.editor) return info.editor;
	return null;
}
