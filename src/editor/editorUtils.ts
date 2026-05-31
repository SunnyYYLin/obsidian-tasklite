import type { App, Editor, TFile } from "obsidian";

export function findOpenMarkdownEditor(app: App, path: string): Editor | null {
	const workspace = app?.workspace as {
		activeEditor?: unknown;
		getLeavesOfType?: (viewType: string) => Array<{view: unknown}>;
	} | undefined;
	if (!workspace) return null;

	const activeEditor = getEditorForPath(workspace.activeEditor, path);
	if (activeEditor) return activeEditor;

	for (const leaf of workspace.getLeavesOfType?.("markdown") ?? []) {
		const editor = getEditorForPath(leaf.view, path);
		if (editor) return editor;
	}

	return null;
}

export function getEditorForPath(value: unknown, path: string): Editor | null {
	const info = value as {file?: TFile | null; editor?: Editor} | null | undefined;
	if (info?.file?.path === path && info.editor) return info.editor;
	return null;
}
