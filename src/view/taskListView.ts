import { ItemView, Notice, setIcon, type App, type WorkspaceLeaf } from "obsidian";
import type { TaskLiteCoreApi, TaskLiteTaskRecord } from "../api/taskLiteCoreApi";
import { TASK_SYMBOLS, serializeTaskBody, type TaskLine, type TaskMetadata } from "../model/format";
import { todayString } from "../model/recurrence";
import type { StatusRegistry } from "../model/status";
import type { TaskLiteSettings } from "../settings";
import { openTaskLineModalWithTarget } from "../ui/taskLineModal";
import { t } from "../i18n";
import { compareTaskTodoItems } from "./taskTodoSort";

export const TASKLITE_TASK_LIST_VIEW = "taskslite-task-list";

interface TaskListItem {
	path: string;
	basename: string;
	lineNumber: number;
	parentLine: number | null;
	depth: number;
	hasChildren: boolean;
	task: TaskLine;
	date: string | null;
	dateType: "due" | "scheduled" | "start" | null;
	parent: TaskListItem | null;
	children: TaskListItem[];
}

interface TaskGroup {
	id: string;
	title: string;
	items: TaskListItem[];
	collapsed: boolean;
}

export class TaskLiteTaskListView extends ItemView {
	private readonly collapsedGroups = new Set<string>(["overdue"]);
	private readonly expandedTasks = new Set<string>();
	private renderVersion = 0;
	private renderTimer: number | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly appRef: App,
		private readonly api: TaskLiteCoreApi,
		private readonly registry: StatusRegistry,
		private readonly getSettings: () => TaskLiteSettings,
	) {
		super(leaf);
	}

	getViewType(): string {
		return TASKLITE_TASK_LIST_VIEW;
	}

	getDisplayText(): string {
		return "TaskLite";
	}

	getIcon(): string {
		return "list-todo";
	}

	async onOpen(): Promise<void> {
		this.containerEl.addClass("taskslite-list-view");
		this.registerEvent(this.appRef.vault.on("modify", () => this.queueRender()));
		this.registerEvent(this.appRef.vault.on("create", () => this.queueRender()));
		this.registerEvent(this.appRef.vault.on("delete", () => this.queueRender()));
		this.registerEvent(this.appRef.vault.on("rename", () => this.queueRender()));
		await this.render();
	}

	async onClose(): Promise<void> {
		if (this.renderTimer !== null) {
			window.clearTimeout(this.renderTimer);
			this.renderTimer = null;
		}
	}

	private queueRender(): void {
		if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
		this.renderTimer = window.setTimeout(() => {
			this.renderTimer = null;
			void this.render();
		}, 150);
	}

	private async render(): Promise<void> {
		const version = ++this.renderVersion;
		const tasks = await this.loadTasks();
		if (version !== this.renderVersion) return;

		const content = this.contentEl;
		content.empty();
		content.addClass("taskslite-list-root");

		this.renderHeader(content, tasks.length);
		this.renderAddButton(content);
		for (const group of groupTasks(tasks, this.collapsedGroups)) {
			this.renderGroup(content, group);
		}
	}

	private renderHeader(container: HTMLElement, count: number): void {
		const header = container.createDiv({cls: "taskslite-list-header"});
		const title = header.createDiv({cls: "taskslite-list-title"});
		const icon = title.createSpan({cls: "taskslite-list-title-icon"});
		setIcon(icon, "list-todo");
		title.createSpan({text: "TaskLite"});
		header.createSpan({text: `${count}`, cls: "taskslite-list-count"});

		const refreshButton = header.createEl("button", {cls: "taskslite-icon-button", attr: {"aria-label": t("common.refresh")}});
		setIcon(refreshButton, "refresh-cw");
		refreshButton.addEventListener("click", () => {
			void this.render();
		});
	}

	private renderAddButton(container: HTMLElement): void {
		const button = container.createEl("button", {cls: "taskslite-add-task"});
		const icon = button.createSpan();
		setIcon(icon, "plus");
		button.createSpan({text: t("taskTodo.addTask")});
		button.addEventListener("click", async () => {
			await this.createInboxTask();
		});
	}

	private renderGroup(container: HTMLElement, group: TaskGroup): void {
		const section = container.createEl("section", {cls: "taskslite-list-section"});
		const header = section.createEl("button", {cls: "taskslite-section-header", attr: {"aria-expanded": String(!group.collapsed)}});
		const chevron = header.createSpan({cls: "taskslite-section-chevron"});
		setIcon(chevron, group.collapsed ? "chevron-right" : "chevron-down");
		header.createSpan({text: group.title, cls: "taskslite-section-title"});
		header.createSpan({text: `${group.items.length}`, cls: "taskslite-section-count"});
		header.addEventListener("click", () => {
			if (this.collapsedGroups.has(group.id)) this.collapsedGroups.delete(group.id);
			else this.collapsedGroups.add(group.id);
			void this.render();
		});

		if (group.collapsed) return;
		const list = section.createDiv({cls: "taskslite-task-list"});
		for (const item of group.items) {
			this.renderTaskItem(list, item);
		}
	}

	private renderTaskItem(container: HTMLElement, item: TaskListItem): void {
		const wrapper = container.createDiv({cls: "taskslite-list-item-wrapper"});
		const row = wrapper.createDiv({cls: "taskslite-list-item"});
		const checkbox = row.createEl("button", {cls: "taskslite-list-checkbox", attr: {"aria-label": t("task.action.complete")}});
		checkbox.addEventListener("click", async (event) => {
			event.preventDefault();
			event.stopPropagation();
			checkbox.setAttr("disabled", "true");
			await this.api.finishTask(item.path, item.lineNumber);
			await this.render();
		});

		const body = row.createDiv({cls: "taskslite-list-item-body"});
		this.renderItemTitle(body, item);
		this.renderItemMeta(body, item);
		this.renderItemActions(row, item);

		row.addEventListener("click", async () => {
			await this.openTask(item);
		});

		if (item.hasChildren && this.expandedTasks.has(taskKey(item))) {
			this.renderChildList(wrapper, item);
		}
	}

	private renderItemTitle(container: HTMLElement, item: TaskListItem): void {
		const titleRow = container.createDiv({cls: "taskslite-list-item-title-row"});
		if (item.hasChildren) {
			const expanded = this.expandedTasks.has(taskKey(item));
			const expandButton = titleRow.createEl("button", {
				cls: "taskslite-task-expand",
				attr: {"aria-label": expanded ? t("task.action.collapseSubtasks") : t("task.action.expandSubtasks"), "aria-expanded": String(expanded)},
			});
			setIcon(expandButton, expanded ? "chevron-down" : "chevron-right");
			expandButton.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				this.toggleTaskExpanded(item);
			});
		}
		titleRow.createDiv({text: item.task.metadata.description, cls: "taskslite-list-item-title"});
	}

	private renderItemMeta(container: HTMLElement, item: TaskListItem): void {
		const meta = container.createDiv({cls: "taskslite-list-item-meta"});
		meta.createSpan({text: item.basename});
		if (item.parent) {
			meta.createSpan({text: "-", cls: "taskslite-meta-separator"});
			meta.createSpan({text: item.parent.task.metadata.description, cls: "taskslite-list-parent"});
		}

		const dateLabel = formatDateLabel(item);
		if (dateLabel) {
			meta.createSpan({text: "-", cls: "taskslite-meta-separator"});
			const date = meta.createSpan({text: dateLabel, cls: "taskslite-list-date"});
			if (item.dateType === "due") date.addClass("taskslite-list-date-due");
		}

		const suffix = serializeTaskBody(metadataWithoutPrimaryDate(item.task, item.dateType)).trim();
		if (suffix) {
			meta.createSpan({text: "-", cls: "taskslite-meta-separator"});
			meta.createSpan({text: suffix, cls: "taskslite-list-metadata"});
		}
	}

	private renderItemActions(row: HTMLElement, item: TaskListItem): void {
		const actions = row.createDiv({cls: "taskslite-list-actions"});
		const cancelButton = actions.createEl("button", {cls: "taskslite-list-action", attr: {"aria-label": t("task.action.cancel")}});
		setIcon(cancelButton, "circle-slash");
		cancelButton.addEventListener("click", async (event) => {
			event.preventDefault();
			event.stopPropagation();
			cancelButton.setAttr("disabled", "true");
			await this.api.cancelTask(item.path, item.lineNumber);
			await this.render();
		});
	}

	private renderChildList(container: HTMLElement, item: TaskListItem): void {
		const children = item.children.filter((child) => isVisibleTask(child));
		if (children.length === 0) return;

		const list = container.createDiv({cls: "taskslite-child-list"});
		for (const child of children) {
			this.renderTaskItem(list, child);
		}
	}

	private async openTask(item: TaskListItem): Promise<void> {
		const file = this.appRef.vault.getFileByPath(item.path);
		if (file) await this.appRef.workspace.getLeaf(false).openFile(file, {eState: {line: item.lineNumber}});
	}

	private toggleTaskExpanded(item: TaskListItem): void {
		const key = taskKey(item);
		if (this.expandedTasks.has(key)) this.expandedTasks.delete(key);
		else this.expandedTasks.add(key);
		void this.render();
	}

	private async loadTasks(): Promise<TaskListItem[]> {
		const records = await this.api.listTasks({includeChildren: true});
		const items = taskRecordsToListItems(records).filter(isVisibleTask);
		return items.sort(compareTaskTodoItems);
	}

	private async createInboxTask(): Promise<void> {
		const result = await openTaskLineModalWithTarget({
			app: this.appRef,
			title: t("taskTodo.createTask"),
			initialLine: "",
			registry: this.registry,
			settings: this.getSettings(),
			targetFile: {
				basePath: "Tasks",
				defaultValue: "New_Tasks",
			},
		});
		if (!result) return;

		try {
			await this.api.createTask(result.line, {path: result.targetPath});
		} catch (error) {
			new Notice(t("notice.inboxPathFolder"));
			console.warn("TaskLite failed to create inbox task", error);
		}
		await this.render();
	}
}

function taskRecordsToListItems(records: TaskLiteTaskRecord[]): TaskListItem[] {
	const items: TaskListItem[] = records.map((record): TaskListItem => {
		const {date, dateType} = taskListDate(record.task);
		return {
			path: record.path,
			basename: record.basename,
			lineNumber: record.lineNumber,
			parentLine: record.parentLine,
			depth: record.depth,
			hasChildren: record.hasChildren,
			task: record.task,
			date,
			dateType,
			parent: null,
			children: [],
		};
	});

	const byKey = new Map(items.map((item) => [taskKey(item), item]));
	for (const item of items) {
		if (item.parentLine === null) continue;
		const parent = byKey.get(`${item.path}:${item.parentLine}`);
		if (!parent) continue;
		item.parent = parent;
		parent.children.push(item);
	}
	return items;
}

function isVisibleTask(item: TaskListItem): boolean {
	return item.task.status.type !== "DONE" && item.task.status.type !== "CANCELLED";
}

function taskListDate(task: TaskLine): Pick<TaskListItem, "date" | "dateType"> {
	if (task.metadata.dates.due) return {date: task.metadata.dates.due, dateType: "due"};
	if (task.metadata.dates.scheduled) return {date: task.metadata.dates.scheduled, dateType: "scheduled"};
	if (task.metadata.dates.start) return {date: task.metadata.dates.start, dateType: "start"};
	return {date: null, dateType: null};
}

function groupTasks(tasks: TaskListItem[], collapsedGroups: Set<string>): TaskGroup[] {
	const today = todayString();
	const tomorrow = shiftDate(today, 1);
	const nextWeek = shiftDate(today, 7);
	const buckets: TaskGroup[] = [
		{id: "overdue", title: t("taskTodo.group.earlier"), items: [], collapsed: collapsedGroups.has("overdue")},
		{id: "today", title: t("taskTodo.group.today"), items: [], collapsed: collapsedGroups.has("today")},
		{id: "tomorrow", title: t("taskTodo.group.tomorrow"), items: [], collapsed: collapsedGroups.has("tomorrow")},
		{id: "week", title: t("taskTodo.group.next7Days"), items: [], collapsed: collapsedGroups.has("week")},
		{id: "later", title: t("taskTodo.group.later"), items: [], collapsed: collapsedGroups.has("later")},
		{id: "none", title: t("taskTodo.group.noDate"), items: [], collapsed: collapsedGroups.has("none")},
	];

	for (const task of tasks) {
		const date = task.date;
		if (!date) buckets[5]!.items.push(task);
		else if (date < today) buckets[0]!.items.push(task);
		else if (date === today) buckets[1]!.items.push(task);
		else if (date === tomorrow) buckets[2]!.items.push(task);
		else if (date <= nextWeek) buckets[3]!.items.push(task);
		else buckets[4]!.items.push(task);
	}

	return buckets.filter((group) => group.items.length > 0);
}

function formatDateLabel(item: TaskListItem): string | null {
	if (!item.date) return null;
	const prefix = item.dateType === "due" ? TASK_SYMBOLS.due : item.dateType === "scheduled" ? TASK_SYMBOLS.scheduled : TASK_SYMBOLS.start;
	return `${prefix} ${item.date}`;
}

function metadataWithoutPrimaryDate(task: TaskLine, dateType: TaskListItem["dateType"]): TaskMetadata {
	const metadata: TaskMetadata = {
		...task.metadata,
		description: "",
		dates: {...task.metadata.dates},
		tags: [...task.metadata.tags],
	};
	if (dateType) metadata.dates[dateType] = null;
	return metadata;
}

function taskKey(item: Pick<TaskListItem, "path" | "lineNumber">): string {
	return `${item.path}:${item.lineNumber}`;
}

function shiftDate(value: string, amount: number): string {
	const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
	if (year === undefined || month === undefined || day === undefined) return value;
	const date = new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1));
	date.setUTCDate(date.getUTCDate() + amount);
	return `${date.getUTCFullYear().toString().padStart(4, "0")}-${(date.getUTCMonth() + 1).toString().padStart(2, "0")}-${date.getUTCDate().toString().padStart(2, "0")}`;
}
