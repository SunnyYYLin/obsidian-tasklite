import type { App, CachedMetadata, Editor } from "obsidian";
import { Notice, TFile } from "obsidian";
import type { StatusRegistry } from "../model/status";
import type { TasksLiteSettings } from "../settings";
import { toggleTaskAtLine } from "./toggle";

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
	settings: TasksLiteSettings;
}): boolean {
	const cursor = editor.getCursor();
	const lines = Array.from({length: editor.lineCount()}, (_value, index) => editor.getLine(index));
	const metadata = getFileCache(app, path);
	const result = toggleTaskAtLine({lines, lineNumber: cursor.line, metadata, registry, settings});
	if (!result) return false;

	const from = {line: result.fromLine, ch: 0};
	const lastLine = editor.getLine(result.toLine);
	const to = {line: result.toLine, ch: lastLine.length};
	editor.replaceRange(result.replacement.join("\n"), from, to);
	editor.setCursor({line: result.fromLine, ch: Math.min(cursor.ch, result.replacement[0]?.length ?? 0)});
	if (result.warning) new Notice(result.warning);
	return true;
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
	settings: TasksLiteSettings;
}): Promise<boolean> {
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) return false;
	const content = await app.vault.read(file);
	const lines = content.split("\n");
	const result = toggleTaskAtLine({lines, lineNumber, metadata: app.metadataCache.getFileCache(file), registry, settings});
	if (!result) return false;

	lines.splice(result.fromLine, result.toLine - result.fromLine + 1, ...result.replacement);
	await app.vault.modify(file, lines.join("\n"));
	if (result.warning) new Notice(result.warning);
	return true;
}

function getFileCache(app: App, path: string): CachedMetadata | null {
	const file = app.vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile)) return null;
	return app.metadataCache.getFileCache(file);
}
