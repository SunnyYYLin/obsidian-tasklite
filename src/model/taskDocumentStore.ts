import type { App, CachedMetadata, Plugin, TFile } from "obsidian";
import { buildTaskTree, taskDepth, type TaskTree, type TaskTreeNode } from "./tree";
import type { StatusRegistry } from "./status";
import type { TaskData, TaskLine } from "./format";
import { parseFrontmatterTask, type FrontmatterTaskRecord } from "./frontmatterTask";

export type { FrontmatterTaskRecord };

export interface TaskDocument {
	path: string;
	basename: string;
	file: TFile;
	lines: string[];
	tree: TaskTree;
	content: string;
	/** File-level task encoded in frontmatter, or null if not present. */
	frontmatterTask: FrontmatterTaskRecord | null;
}

export interface TaskDocumentRecord {
	path: string;
	basename: string;
	lineNumber: number;
	parentLine: number | null;
	depth: number;
	hasChildren: boolean;
	task: TaskData;
}

export class TaskDocumentStore {
	private readonly documents = new Map<string, TaskDocument>();
	private readonly recordsByPath = new Map<string, TaskDocumentRecord[]>();
	private readonly dirtyPaths = new Set<string>();
	private readonly rebuildTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private indexedAllFiles = false;

	constructor(
		private readonly app: App,
		private readonly registry: StatusRegistry,
	) {}

	register(plugin: Plugin): void {
		plugin.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				if (!isMarkdownFile(file)) return;
				this.queueRebuild(file);
			}),
		);
		plugin.registerEvent(
			this.app.vault.on("create", (file) => {
				if (!isMarkdownFile(file)) return;
				this.queueRebuild(file);
			}),
		);
		plugin.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (!isPathFile(file)) return;
				this.forget(file.path);
			}),
		);
		plugin.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.forget(oldPath);
				if (isMarkdownFile(file)) this.queueRebuild(file);
			}),
		);
	}

	invalidate(path: string): void {
		this.dirtyPaths.add(path);
	}

	getCachedContent(path: string): string | null {
		return this.documents.get(path)?.content ?? null;
	}

	invalidateAll(): void {
		this.documents.clear();
		this.recordsByPath.clear();
		this.dirtyPaths.clear();
		this.indexedAllFiles = false;
	}

	forget(path: string): void {
		this.documents.delete(path);
		this.recordsByPath.delete(path);
		this.dirtyPaths.delete(path);
		const timer = this.rebuildTimers.get(path);
		if (timer !== undefined) clearTimeout(timer);
		this.rebuildTimers.delete(path);
	}

	async getDocumentByPath(path: string): Promise<TaskDocument | null> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!isMarkdownFile(file)) return null;
		return this.getDocument(file);
	}

	async getDocument(file: TFile): Promise<TaskDocument | null> {
		const existing = this.documents.get(file.path);
		if (existing && !this.dirtyPaths.has(file.path)) return existing;
		return this.rebuildFile(file);
	}

	async replaceDocumentContent(file: TFile, content: string): Promise<TaskDocument | null> {
		// 主动修改内容时，Obsidian 的 metadataCache 必定滞后，传入 null 强制使用 inferListItems
		return this.setDocument(file, content, null);
	}

	async listRecords(): Promise<TaskDocumentRecord[]> {
		await this.ensureAllFilesIndexed();
		const records: TaskDocumentRecord[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (this.dirtyPaths.has(file.path)) await this.rebuildFile(file);
			records.push(...(this.recordsByPath.get(file.path) ?? []));
		}
		return records;
	}

	private queueRebuild(file: TFile): void {
		this.invalidate(file.path);
		const existingTimer = this.rebuildTimers.get(file.path);
		if (existingTimer !== undefined) clearTimeout(existingTimer);
		const timer = setTimeout(() => {
			this.rebuildTimers.delete(file.path);
			void this.rebuildFile(file);
		}, 200);
		this.rebuildTimers.set(file.path, timer);
	}

	private async ensureAllFilesIndexed(): Promise<void> {
		if (this.indexedAllFiles) return;
		for (const file of this.app.vault.getMarkdownFiles()) {
			await this.getDocument(file);
		}
		this.indexedAllFiles = true;
	}

	private async rebuildFile(file: TFile): Promise<TaskDocument | null> {
		const content = await this.app.vault.cachedRead(file);
		return this.setDocument(file, content, this.app.metadataCache.getFileCache(file));
	}

	private setDocument(file: TFile, content: string, metadata: CachedMetadata | null): TaskDocument | null {
		if (shouldIgnoreFile(metadata)) {
			this.forget(file.path);
			return null;
		}
		const lines = content.split("\n");
		const tree = buildTaskTree(lines, metadata, this.registry);
		const hasBodyTasks = tree.nodes.some((n) => n.task);
		const frontmatterTask = parseFrontmatterTask(file, metadata, this.registry, hasBodyTasks);
		const document: TaskDocument = {
			path: file.path,
			basename: file.basename,
			file,
			lines,
			tree,
			content,
			frontmatterTask,
		};
		this.documents.set(file.path, document);
		this.recordsByPath.set(file.path, taskRecordsFromDocument(document));
		this.dirtyPaths.delete(file.path);
		return document;
	}
}

function taskRecordsFromDocument(document: TaskDocument): TaskDocumentRecord[] {
	const records: TaskDocumentRecord[] = [];
	const hasFm = !!document.frontmatterTask;
	if (document.frontmatterTask) {
		records.push(document.frontmatterTask);
	}
	for (const node of document.tree.nodes) {
		if (!node.task) continue;
		const parentLine = (hasFm && node.parentLine === null) ? -1 : node.parentLine;
		const depth = (hasFm && node.parentLine === null) ? 0 : taskDepth(node);
		records.push({
			path: document.path,
			basename: document.basename,
			lineNumber: node.lineNumber,
			parentLine: parentLine,
			depth: depth,
			hasChildren: node.children.some((child) => child.task),
			task: node.task.data,
		});
	}
	return records;
}



function isMarkdownFile(value: unknown): value is TFile {
	return Boolean(
		value &&
			typeof value === "object" &&
			"path" in value &&
			"basename" in value &&
			"extension" in value &&
			(value as {extension?: unknown}).extension === "md",
	);
}

function shouldIgnoreFile(metadata: CachedMetadata | null): boolean {
	return metadata?.frontmatter?.tasks === "ignore";
}

function isPathFile(value: unknown): value is {path: string} {
	return Boolean(value && typeof value === "object" && "path" in value && typeof (value as {path?: unknown}).path === "string");
}
