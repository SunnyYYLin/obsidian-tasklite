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

/**
 * Safely read Obsidian's internal vault indent configuration.
 * Falls back to sensible defaults (tab, size=4) if the internal config is unavailable.
 */
export function getVaultIndentConfig(app: App): { useTab: boolean; tabSize: number } {
	const cfg = (app.vault as unknown as { config?: Record<string, unknown> } | undefined)?.config ?? {};
	return {
		useTab: typeof cfg.useTab === "boolean" ? cfg.useTab : true,
		tabSize: typeof cfg.tabSize === "number" && cfg.tabSize > 0 ? cfg.tabSize : 4,
	};
}

/**
 * Returns true when Obsidian's internal vault config object is present.
 * Used to decide whether to trust `getVaultIndentConfig` or fall back to
 * document-content heuristics.
 */
export function hasVaultConfig(app: App): boolean {
	return Boolean(
		(app.vault as unknown as { config?: unknown } | undefined)?.config,
	);
}

