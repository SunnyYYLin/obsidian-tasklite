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
