import type { App, CachedMetadata, Plugin, TFile } from "obsidian";
import { buildTaskTree, taskDepth, getTaskParentLine, type TaskTree } from "./tree";
import type { StatusRegistry } from "./status";
import type { TaskData } from "./format";
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

export interface CachedFileRecord {
	mtime: number;
	records: TaskDocumentRecord[];
}

export interface TaskStoreCacheSnapshot {
	version: number;
	files: Record<string, CachedFileRecord>;
}

export class TaskDocumentStore {
	private readonly documents = new Map<string, TaskDocument>();
	private readonly recordsByPath = new Map<string, TaskDocumentRecord[]>();
	private readonly dirtyPaths = new Set<string>();
	private readonly cachedMtimes = new Map<string, number>();
	private readonly rebuildTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private indexedAllFiles = false;
	private cacheLoaded = false;
	private loadCachePromise: Promise<void> | null = null;
	private indexingPromise: Promise<void> | null = null;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;

	onRecordUpdated?: (path: string, records: TaskDocumentRecord[]) => void;
	onTasksCompleted?: (completedIds: string[]) => void;

	constructor(
		private readonly app: App,
		private readonly registry: StatusRegistry,
	) {}

	register(plugin: Plugin): void {
		void this.loadCache();
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
				if (isFolder(file)) {
					this.forgetFolder(file.path);
				} else if (isPathFile(file)) {
					this.forget(file.path);
				}
			}),
		);
		plugin.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (isFolder(file)) {
					this.forgetFolder(oldPath);
					const mdFiles = collectMarkdownFiles(file);
					for (const mdFile of mdFiles) {
						this.queueRebuild(mdFile);
					}
				} else {
					this.forget(oldPath);
					if (isMarkdownFile(file)) this.queueRebuild(file);
				}
			}),
		);
	}

	private getCachePath(): string {
		const configDir = this.app.vault.configDir || ".obsidian"; // eslint-disable-line obsidianmd/hardcoded-config-path
		return `${configDir}/plugins/taskslite/task-cache.json`;
	}

	private getPluginDir(): string {
		const configDir = this.app.vault.configDir || ".obsidian"; // eslint-disable-line obsidianmd/hardcoded-config-path
		return `${configDir}/plugins/taskslite`;
	}

	async loadCache(): Promise<void> {
		if (this.cacheLoaded) return;
		if (this.loadCachePromise) return this.loadCachePromise;

		this.loadCachePromise = (async () => {
			if (!this.app.vault?.adapter) {
				this.cacheLoaded = true;
				return;
			}
			const cachePath = this.getCachePath();
			try {
				if (await this.app.vault.adapter.exists(cachePath)) {
					const raw = await this.app.vault.adapter.read(cachePath);
					const snapshot = JSON.parse(raw) as TaskStoreCacheSnapshot;
					if (snapshot && snapshot.version === 1 && snapshot.files && typeof snapshot.files === "object") {
						for (const [path, entry] of Object.entries(snapshot.files)) {
							if (entry && typeof entry.mtime === "number" && Array.isArray(entry.records)) {
								this.cachedMtimes.set(path, entry.mtime);
								this.recordsByPath.set(path, entry.records);
							}
						}
					}
				}
			} catch (e) {
				console.warn("TaskLite: failed to load task-cache.json, will rebuild", e);
			} finally {
				this.cacheLoaded = true;
			}
		})().finally(() => {
			this.loadCachePromise = null;
		});

		return this.loadCachePromise;
	}

	private scheduleSaveCache(): void {
		if (!this.app.vault?.adapter) return;
		if (this.saveTimer !== null) {
			clearTimeout(this.saveTimer);
		}
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			void this.saveCache();
		}, 1500);
	}

	async saveCache(): Promise<void> {
		if (this.saveTimer !== null) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		if (!this.app.vault?.adapter) return;

		const pluginDir = this.getPluginDir();
		const cachePath = this.getCachePath();

		try {
			const files: Record<string, CachedFileRecord> = {};
			for (const [path, records] of this.recordsByPath.entries()) {
				const mtime = this.cachedMtimes.get(path) ?? 0;
				files[path] = {
					mtime,
					records,
				};
			}
			const snapshot: TaskStoreCacheSnapshot = {
				version: 1,
				files,
			};
			if (!(await this.app.vault.adapter.exists(pluginDir))) {
				await this.app.vault.adapter.mkdir(pluginDir);
			}
			await this.app.vault.adapter.write(cachePath, JSON.stringify(snapshot));
		} catch (e) {
			console.warn("TaskLite: failed to save task-cache.json", e);
		}
	}

	getActiveAssignees(): string[] {
		const set = new Set<string>();
		for (const records of this.recordsByPath.values()) {
			for (const record of records) {
				const assignees = record.task.assignee;
				if (assignees && Array.isArray(assignees)) {
					for (const a of assignees) {
						const trimmed = a.trim();
						if (trimmed) set.add(trimmed);
					}
				}
			}
		}
		return Array.from(set).sort((a, b) => a.localeCompare(b));
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
		this.cachedMtimes.clear();
		this.indexedAllFiles = false;
		this.cacheLoaded = false;
	}

	forget(path: string): void {
		this.documents.delete(path);
		this.recordsByPath.delete(path);
		this.dirtyPaths.delete(path);
		this.cachedMtimes.delete(path);
		const timer = this.rebuildTimers.get(path);
		if (timer !== undefined) clearTimeout(timer);
		this.rebuildTimers.delete(path);
		this.scheduleSaveCache();
		triggerWorkspaceEvent(this.app, "tasklite:tasks-changed", { path: path });
	}

	forgetFolder(folderPath: string): void {
		const prefix = folderPath.endsWith("/") ? folderPath : `${folderPath}/`;
		const pathsToForget: string[] = [];
		for (const p of this.recordsByPath.keys()) {
			if (p === folderPath || p.startsWith(prefix)) {
				pathsToForget.push(p);
			}
		}
		for (const p of pathsToForget) {
			this.forget(p);
		}
		triggerWorkspaceEvent(this.app, "tasklite:tasks-changed", { path: folderPath });
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
		const cache = this.app.metadataCache.getFileCache(file);
		const metadata = cache?.frontmatter
			? ({ frontmatter: cache.frontmatter } as CachedMetadata)
			: null;
		return this.setDocument(file, content, metadata);
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

	listCachedRecords(): TaskDocumentRecord[] {
		const records: TaskDocumentRecord[] = [];
		for (const file of this.app.vault.getMarkdownFiles()) {
			records.push(...(this.recordsByPath.get(file.path) ?? []));
		}
		return records;
	}

	getCachedDocument(path: string): TaskDocument | null {
		return this.documents.get(path) ?? null;
	}

	private queueRebuild(file: TFile): void {
		this.invalidate(file.path);
		if (!this.indexedAllFiles) return;
		const existingTimer = this.rebuildTimers.get(file.path);
		if (existingTimer !== undefined) clearTimeout(existingTimer);
		const timer = setTimeout(() => {
			this.rebuildTimers.delete(file.path);
			void this.rebuildFile(file);
		}, 200);
		this.rebuildTimers.set(file.path, timer);
	}

	async ensureAllFilesIndexed(): Promise<void> {
		if (this.indexedAllFiles) return;
		if (this.indexingPromise) return this.indexingPromise;

		this.indexingPromise = (async () => {
			await this.loadCache();

			const files = this.app.vault.getMarkdownFiles();
			const currentPaths = new Set(files.map((f) => f.path));

			// Prune files in cache that no longer exist in vault
			for (const cachedPath of Array.from(this.recordsByPath.keys())) {
				if (!currentPaths.has(cachedPath)) {
					this.recordsByPath.delete(cachedPath);
					this.cachedMtimes.delete(cachedPath);
					this.documents.delete(cachedPath);
					this.dirtyPaths.delete(cachedPath);
				}
			}

			const filesToLoad: TFile[] = [];

			for (const file of files) {
				const isDirty = this.dirtyPaths.has(file.path);
				const cachedMtime = this.cachedMtimes.get(file.path);
				const fileMtime = (file.stat && typeof file.stat.mtime === "number") ? file.stat.mtime : null;

				// If cache hit and not dirty, reuse cached records
				if (!isDirty && fileMtime !== null && cachedMtime === fileMtime && this.recordsByPath.has(file.path)) {
					continue;
				}

				const metadata = this.app.metadataCache.getFileCache(file);
				if (metadata && !fileMayContainTasks(metadata)) {
					this.recordsByPath.set(file.path, []);
					if (fileMtime !== null) {
						this.cachedMtimes.set(file.path, fileMtime);
					}
					this.dirtyPaths.delete(file.path);
				} else {
					filesToLoad.push(file);
				}
			}

			const CONCURRENCY = 20;
			for (let i = 0; i < filesToLoad.length; i += CONCURRENCY) {
				await Promise.all(filesToLoad.slice(i, i + CONCURRENCY).map((f) => this.rebuildFile(f)));
			}
			this.indexedAllFiles = true;
			this.scheduleSaveCache();
		})().finally(() => {
			this.indexingPromise = null;
		});

		return this.indexingPromise;
	}

	private async rebuildFile(file: TFile): Promise<TaskDocument | null> {
		const metadata = this.app.metadataCache.getFileCache(file);
		if (metadata && !fileMayContainTasks(metadata)) {
			this.forget(file.path);
			this.recordsByPath.set(file.path, []);
			this.dirtyPaths.delete(file.path);
			if (file.stat && typeof file.stat.mtime === "number") {
				this.cachedMtimes.set(file.path, file.stat.mtime);
			}
			this.onRecordUpdated?.(file.path, []);
			this.scheduleSaveCache();
			return null;
		}
		const content = await this.app.vault.cachedRead(file);
		return this.setDocument(file, content, metadata);
	}

	private setDocument(file: TFile, content: string, metadata: CachedMetadata | null): TaskDocument | null {
		if (shouldIgnoreFile(metadata)) {
			this.forget(file.path);
			return null;
		}
		const oldDoc = this.documents.get(file.path);
		const lines = content.split("\n");
		const tree = buildTaskTree(lines, metadata, this.registry);
		const hasBodyTasks = tree.nodes.some((n) => n.task);
		const frontmatterTask = parseFrontmatterTask(file, metadata, this.registry, hasBodyTasks, content);
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
		const records = taskRecordsFromDocument(document);
		this.recordsByPath.set(file.path, records);
		if (file.stat && typeof file.stat.mtime === "number") {
			this.cachedMtimes.set(file.path, file.stat.mtime);
		}
		this.dirtyPaths.delete(file.path);
		this.scheduleSaveCache();

		if (oldDoc && this.onTasksCompleted) {
			const beforeDone = new Set<string>();
			if (oldDoc.frontmatterTask?.task.id && oldDoc.frontmatterTask.task.status === "DONE") {
				beforeDone.add(oldDoc.frontmatterTask.task.id);
			}
			for (const node of oldDoc.tree.nodes) {
				if (node.task?.data.id && node.task.data.status === "DONE") {
					beforeDone.add(node.task.data.id);
				}
			}

			const newlyCompleted: string[] = [];
			if (frontmatterTask?.task.id && frontmatterTask.task.status === "DONE") {
				if (!beforeDone.has(frontmatterTask.task.id)) {
					newlyCompleted.push(frontmatterTask.task.id);
				}
			}
			for (const node of tree.nodes) {
				if (node.task?.data.id && node.task.data.status === "DONE") {
					if (!beforeDone.has(node.task.data.id)) {
						newlyCompleted.push(node.task.data.id);
					}
				}
			}

			if (newlyCompleted.length > 0) {
				this.onTasksCompleted(newlyCompleted);
			}
		}

		this.onRecordUpdated?.(file.path, records);
		triggerWorkspaceEvent(this.app, "tasklite:tasks-changed", { path: file.path });
		return document;
	}

	/** Cancel all pending debounce timers and clear cached state. Call on plugin unload. */
	destroy(): void {
		for (const timer of this.rebuildTimers.values()) {
			clearTimeout(timer);
		}
		this.rebuildTimers.clear();
		if (this.saveTimer !== null) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
			void this.saveCache();
		}
		this.documents.clear();
		this.recordsByPath.clear();
		this.dirtyPaths.clear();
		this.cachedMtimes.clear();
		this.indexedAllFiles = false;
		this.cacheLoaded = false;
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
		const taskParentLine = getTaskParentLine(node);
		const parentLine = (hasFm && taskParentLine === null) ? -1 : taskParentLine;
		const depth = (hasFm && taskParentLine === null) ? 0 : taskDepth(node);
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

function shouldIgnoreFile(metadata: CachedMetadata | null | undefined): boolean {
	return metadata?.frontmatter?.tasks === "ignore";
}

export function fileMayContainTasks(metadata: CachedMetadata | null | undefined): boolean {
	if (!metadata) return true;
	if (shouldIgnoreFile(metadata)) return false;
	if (metadata.frontmatter && Boolean(metadata.frontmatter["task"])) return true;
	if (metadata.listItems && metadata.listItems.some((item) => item.task !== undefined)) return true;
	return false;
}

function isPathFile(value: unknown): value is {path: string} {
	return Boolean(value && typeof value === "object" && "path" in value && typeof (value as {path?: unknown}).path === "string");
}
function isFolder(value: unknown): boolean {
	return Boolean(
		value &&
			typeof value === "object" &&
			"children" in value &&
			Array.isArray((value as { children?: unknown }).children),
	);
}

function collectMarkdownFiles(folder: unknown, result: TFile[] = []): TFile[] {
	if (!folder || typeof folder !== "object" || !("children" in folder)) return result;
	const children = (folder as { children: unknown[] }).children;
	if (!Array.isArray(children)) return result;
	for (const child of children) {
		if (isMarkdownFile(child)) {
			result.push(child);
		} else if (isFolder(child)) {
			collectMarkdownFiles(child, result);
		}
	}
	return result;
}
interface WorkspaceEventTrigger {
	trigger(name: string, ...data: unknown[]): void;
}

function triggerWorkspaceEvent(app: App, name: string, data: unknown): void {
	const ws = app.workspace as unknown as Partial<WorkspaceEventTrigger> | undefined;
	ws?.trigger?.(name, data);
}
