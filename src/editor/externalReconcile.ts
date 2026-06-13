import { TFile, type App, type Plugin } from "obsidian";
import { reconcileExternalTaskCompletion } from "./externalReconcileCore";
import type { StatusRegistry } from "../model/status";
import type { TaskDocumentStore } from "../model/taskDocumentStore";
import type { TaskLiteSettings } from "../settings";
import { buildTaskTree, taskDepth } from "../model/tree";
import { parseFrontmatterTask, buildFrontmatterPatch, applyFrontmatterPatch } from "../model/frontmatterTask";
import { parseTaskLine, serializeTaskLine } from "../model/format";
import { getIndentPrefix } from "./toggle";

function isTFile(value: unknown): value is TFile {
	return (
		value instanceof TFile ||
		(Boolean(value) &&
			// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
			typeof (value as any).path === "string" &&
			// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
			typeof (value as any).extension === "string")
	);
}

export class ExternalTaskReconciler {
	private readonly applying = new Set<string>();

	constructor(
		private readonly plugin: Plugin,
		private readonly app: App,
		private readonly registry: StatusRegistry,
		private readonly getSettings: () => TaskLiteSettings,
		private readonly documentStore: TaskDocumentStore,
	) {}

	register(): void {
		this.documentStore.onTasksCompleted = (completedIds) => {
			void this.unblockDependentTasks(completedIds);
		};
		this.plugin.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					void this.reconcile(file);
				}
			}),
		);
	}

	private async reconcile(file: TFile): Promise<void> {
		if (this.applying.has(file.path)) return;

		const metadata = this.app.metadataCache.getFileCache(file);
		if (metadata?.frontmatter?.tasks === "ignore") return;

		const docBefore = this.documentStore.getCachedDocument(file.path);
		const before = docBefore?.content ?? null;

		const after = await this.app.vault.read(file);
		await this.documentStore.replaceDocumentContent(file, after);
		if (!before || before === after) return;

		const reconciled = reconcileExternalTaskCompletion({
			before: before.split("\n"),
			after: after.split("\n"),
			registry: this.registry,
			settings: this.getSettings(),
		});

		if (reconciled && reconciled !== after) {
			this.applying.add(file.path);
			try {
				await this.app.vault.modify(file, reconciled);
				await this.documentStore.replaceDocumentContent(file, reconciled);
			} finally {
				this.applying.delete(file.path);
			}
		}
	}

	private async unblockDependentTasks(completedIds: string[]): Promise<void> {
		const records = await this.documentStore.listRecords();
		const updatesByFile = new Map<string, Array<{lineNumber: number, newDependsOn: string | null}>>();

		for (const record of records) {
			if (!record.task.dependsOn) continue;

			const depIds = record.task.dependsOn
				.split(",")
				.map((id) => id.trim())
				.filter(Boolean);

			const remainingIds = depIds.filter((id) => !completedIds.includes(id));

			if (remainingIds.length < depIds.length) {
				const newDependsOn = remainingIds.length > 0 ? remainingIds.join(", ") : null;
				let fileUpdates = updatesByFile.get(record.path);
				if (!fileUpdates) {
					fileUpdates = [];
					updatesByFile.set(record.path, fileUpdates);
				}
				fileUpdates.push({
					lineNumber: record.lineNumber,
					newDependsOn,
				});
			}
		}

		for (const [path, updates] of updatesByFile.entries()) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!isTFile(file)) continue;

			this.applying.add(path);
			try {
				const content = await this.app.vault.read(file);
				const lines = content.split("\n");

				updates.sort((a, b) => b.lineNumber - a.lineNumber);

				for (const update of updates) {
					if (update.lineNumber === -1) {
						const metadata = this.app.metadataCache.getFileCache(file);
						const tree = buildTaskTree(lines, metadata, this.registry);
						const hasBodyTasks = tree.nodes.some((n) => n.task);
						const fmRecord = parseFrontmatterTask(file, metadata, this.registry, hasBodyTasks);
						if (fmRecord) {
							const data = { ...fmRecord.task, dependsOn: update.newDependsOn };
							const fmPatch = buildFrontmatterPatch(fmRecord.task, data, this.registry, fmRecord.rawStatus);
							await applyFrontmatterPatch(this.app.fileManager, file, fmPatch);
						}
					} else {
						const line = lines[update.lineNumber];
						if (line) {
							const statusSymbol = line.match(/\[(.)\]/u)?.[1] ?? " ";
							const type = this.registry.get(statusSymbol).type;
							const parsed = parseTaskLine(line, type);
							if (parsed) {
								parsed.data.dependsOn = update.newDependsOn;
								const tempTree = buildTaskTree(lines, this.app.metadataCache.getFileCache(file), this.registry);
								const node = tempTree.byLine.get(update.lineNumber);
								if (node) {
									const depth = taskDepth(node);
									const indent = getIndentPrefix(depth, this.app, lines);
									lines[update.lineNumber] = serializeTaskLine(parsed, indent, this.registry);
								}
							}
						}
					}
				}

				const nextContent = lines.join("\n");
				await this.app.vault.modify(file, nextContent);
				await this.documentStore.replaceDocumentContent(file, nextContent);
			} catch (err) {
				console.error(`Error unblocking dependent tasks in file ${path}:`, err);
			} finally {
				this.applying.delete(path);
			}
		}
	}
}
