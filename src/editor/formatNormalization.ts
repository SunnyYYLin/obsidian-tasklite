import type { App } from "obsidian";
import type TaskLitePlugin from "../main";
import { serializeTaskLine } from "../model/format";
import { buildTaskTree } from "../model/tree";

export interface NormalizeFormatResult {
	totalUpdatedFiles: number;
	totalUpdatedLines: number;
}

export async function normalizeVaultTaskFormat(
	app: App,
	plugin: TaskLitePlugin,
	targetFormat: "dataview" | "emoji",
): Promise<NormalizeFormatResult> {
	const markdownFiles = app.vault.getMarkdownFiles();
	let totalUpdatedFiles = 0;
	let totalUpdatedLines = 0;

	for (const file of markdownFiles) {
		const metadata = app.metadataCache.getFileCache(file);
		if (metadata?.frontmatter?.tasks === "ignore") continue;

		const content = await app.vault.read(file);
		if (content.length === 0) continue;

		const hasCRLF = content.includes("\r\n");
		const lines = content.split(/\r?\n/u);
		const tree = buildTaskTree(lines, metadata, plugin.statusRegistry);

		let fileChanged = false;
		let fileUpdatedLines = 0;

		for (const node of tree.nodes) {
			if (!node.task) continue;
			const line = lines[node.lineNumber];
			if (line === undefined) continue;

			const newLine = serializeTaskLine(
				node.task,
				node.indentation,
				plugin.statusRegistry,
				targetFormat,
				node.statusCharacter ?? undefined,
			);

			if (newLine !== line) {
				lines[node.lineNumber] = newLine;
				fileChanged = true;
				fileUpdatedLines++;
			}
		}

		if (fileChanged) {
			const newlineChar = hasCRLF ? "\r\n" : "\n";
			const newContent = lines.join(newlineChar);
			await app.vault.modify(file, newContent);
			await plugin.documentStore.replaceDocumentContent(file, newContent);
			totalUpdatedFiles++;
			totalUpdatedLines += fileUpdatedLines;
		}
	}

	return { totalUpdatedFiles, totalUpdatedLines };
}
