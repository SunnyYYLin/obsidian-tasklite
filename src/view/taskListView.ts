import { ItemView, Notice, setIcon, type App, type TFile, type WorkspaceLeaf } from "obsidian";
import type { TaskLiteCoreApi, TaskLiteTaskRecord } from "../api/taskLiteCoreApi";
import { TASK_SYMBOLS, serializeTaskLine, type TaskLine } from "../model/format";
import { todayString } from "../model/recurrence";
import type { StatusRegistry } from "../model/status";
import type { TaskLiteSettings } from "../settings";
import { openTaskLineModal, openTaskLineModalWithTarget } from "../ui/taskLineModal";
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

type TaskListTabId = "in-plan" | "today";

interface TaskListTab {
	id: TaskListTabId;
	title: string;
}

export class TaskLiteTaskListView extends ItemView {
	private readonly collapsedGroups = new Set<string>(["overdue"]);
	private readonly expandedTasks = new Set<string>();
	private activeTab: TaskListTabId = "in-plan";
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

		const tabs = taskListTabs();
		const visibleTasks = filterTasksForTab(tasks, this.activeTab);
		this.renderHeader(content, visibleTasks.length);
		this.renderTabs(content, tabs, visibleTasks);
		for (const group of groupTasks(visibleTasks, this.activeTab, this.collapsedGroups)) {
			this.renderGroup(content, group);
		}
	}

	private renderHeader(container: HTMLElement, count: number): void {
		const header = container.createDiv({cls: "taskslite-list-header"});
		const titleGroup = header.createDiv({cls: "taskslite-list-title-group"});
		const title = titleGroup.createDiv({cls: "taskslite-list-title"});
		const icon = title.createSpan({cls: "taskslite-list-title-icon"});
		setIcon(icon, "list-todo");
		title.createSpan({text: "TaskLite"});
		titleGroup.createSpan({text: `${count}`, cls: "taskslite-list-count"});

		const actions = header.createDiv({cls: "taskslite-list-header-actions"});
		const addButton = actions.createEl("button", {cls: "taskslite-add-task", attr: {"aria-label": t("taskTodo.addTask")}});
		const addIcon = addButton.createSpan();
		setIcon(addIcon, "plus");
		addButton.createSpan({text: t("taskTodo.addTask")});
		addButton.addEventListener("click", async () => {
			await this.createInboxTask();
		});

		const refreshButton = actions.createEl("button", {cls: "taskslite-icon-button", attr: {"aria-label": t("common.refresh")}});
		setIcon(refreshButton, "refresh-cw");
		refreshButton.addEventListener("click", () => {
			void this.render();
		});
	}

	private renderTabs(container: HTMLElement, tabs: TaskListTab[], tasks: TaskListItem[]): void {
		const tabBar = container.createDiv({cls: "taskslite-list-tabs"});
		for (const tab of tabs) {
			const isActive = tab.id === this.activeTab;
			const button = tabBar.createEl("button", {
				cls: `taskslite-list-tab${isActive ? " is-active" : ""}`,
				text: tab.title,
				attr: {
					type: "button",
					"aria-pressed": String(isActive),
				},
			});
			button.addEventListener("click", () => {
				if (this.activeTab === tab.id) return;
				this.activeTab = tab.id;
				void this.render();
			});
		}

		if (tasks.length > 0) return;
		const emptyState = container.createDiv({cls: "taskslite-list-empty"});
		emptyState.setText(this.activeTab === "in-plan" ? t("taskTodo.empty.inPlan") : t("taskTodo.empty.today"));
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
		row.dataset.taskStatusType = item.task.status.type;
		row.dataset.taskStatusSymbol = item.task.status.symbol;
		const checkbox = row.createEl("button", {cls: "taskslite-list-checkbox", attr: {"aria-label": t("task.action.complete")}});
		const checkboxIcon = checkbox.createSpan({cls: "taskslite-list-checkbox-icon"});
		applyTaskStatusIcon(checkboxIcon, item.task.status.type);
		checkbox.addEventListener("click", async (event) => {
			event.preventDefault();
			event.stopPropagation();
			checkbox.setAttr("disabled", "true");
			if (item.task.status.type === "DONE") await this.api.unfinishTask(item.path, item.lineNumber);
			else await this.api.finishTask(item.path, item.lineNumber);
			await this.render();
		});

		const body = row.createDiv({cls: "taskslite-list-item-body"});
		this.renderItemTitle(body, item);
		this.renderItemMeta(body, item);
		this.renderItemActions(row, item);

		row.addEventListener("click", async () => {
			await this.editTask(item);
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
		const context = meta.createDiv({cls: "taskslite-list-item-context"});
		context.createSpan({text: item.basename});
		if (item.parent) context.createSpan({text: item.parent.task.metadata.description, cls: "taskslite-list-parent"});
		if (item.task.metadata.priority) context.createSpan({text: item.task.metadata.priority, cls: "taskslite-list-priority"});

		const dates = meta.createDiv({cls: "taskslite-list-item-dates"});
		for (const datePart of taskDateParts(item.task)) {
			const date = dates.createSpan({text: datePart, cls: "taskslite-list-date"});
			if (datePart.startsWith(TASK_SYMBOLS.due)) date.addClass("taskslite-list-date-due");
		}

		const extra = otherMetadataParts(item.task);
		if (extra.length > 0) {
			const details = meta.createDiv({cls: "taskslite-list-item-details"});
			for (const part of extra) {
				details.createSpan({text: part, cls: "taskslite-list-metadata"});
			}
		}
	}

	private renderItemActions(row: HTMLElement, item: TaskListItem): void {
		const actions = row.createDiv({cls: "taskslite-list-actions"});
		const cancelButton = actions.createEl("button", {cls: "taskslite-list-action", attr: {"aria-label": t("task.action.cancel")}});
		setIcon(cancelButton, item.task.status.type === "CANCELLED" ? "rotate-ccw" : "circle-slash");
		cancelButton.addEventListener("click", async (event) => {
			event.preventDefault();
			event.stopPropagation();
			cancelButton.setAttr("disabled", "true");
			if (item.task.status.type === "CANCELLED") await this.api.uncancelTask(item.path, item.lineNumber);
			else await this.api.cancelTask(item.path, item.lineNumber);
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

	private async editTask(item: TaskListItem): Promise<void> {
		const updatedLine = await openTaskLineModal({
			app: this.appRef,
			title: t("command.editTask"),
			initialLine: serializeTaskLine(item.task),
			registry: this.registry,
			settings: this.getSettings(),
		});
		if (!updatedLine || updatedLine === serializeTaskLine(item.task)) return;

		const file = this.appRef.vault.getAbstractFileByPath(item.path);
		if (!isMarkdownFile(file)) return;
		const content = await this.appRef.vault.read(file);
		const lines = content.split("\n");
		if (item.lineNumber < 0 || item.lineNumber >= lines.length) return;
		lines[item.lineNumber] = updatedLine;
		await this.appRef.vault.modify(file, lines.join("\n"));
		await this.render();
	}

	private toggleTaskExpanded(item: TaskListItem): void {
		const key = taskKey(item);
		if (this.expandedTasks.has(key)) this.expandedTasks.delete(key);
		else this.expandedTasks.add(key);
		void this.render();
	}

	private async loadTasks(): Promise<TaskListItem[]> {
		const records = await this.api.listTasks({
			includeChildren: true,
			includeCompleted: true,
			includeCancelled: true,
		});
		const items = taskRecordsToListItems(records).filter(isVisibleTask);
		return items.sort(compareTaskTodoItems);
	}

	private async createInboxTask(): Promise<void> {
		const parentTasks = (await this.api.listTasks({
			includeChildren: true,
			includeCompleted: true,
			includeCancelled: true,
		}))
			.filter((record) => record.path.startsWith("Tasks/"))
			.map((record) => ({
				label: `${record.basename} / ${record.task.metadata.description}`,
				path: record.path,
				lineNumber: record.lineNumber,
			}));
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
			parentTask: {options: parentTasks},
		});
		if (!result) return;

		try {
			await this.api.createTask(result.line, {path: result.targetPath, parentLineNumber: result.parentLineNumber});
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
	return true;
}

function taskListDate(task: TaskLine): Pick<TaskListItem, "date" | "dateType"> {
	if (task.metadata.dates.due) return {date: task.metadata.dates.due, dateType: "due"};
	if (task.metadata.dates.scheduled) return {date: task.metadata.dates.scheduled, dateType: "scheduled"};
	if (task.metadata.dates.start) return {date: task.metadata.dates.start, dateType: "start"};
	return {date: null, dateType: null};
}

function taskDateParts(task: TaskLine): string[] {
	const parts: string[] = [];
	if (task.metadata.dates.scheduled) parts.push(`${TASK_SYMBOLS.scheduled} ${task.metadata.dates.scheduled}`);
	if (task.metadata.dates.due) parts.push(`${TASK_SYMBOLS.due} ${task.metadata.dates.due}`);
	if (task.metadata.dates.start) parts.push(`${TASK_SYMBOLS.start} ${task.metadata.dates.start}`);
	if (task.metadata.dates.done) parts.push(`${TASK_SYMBOLS.done} ${task.metadata.dates.done}`);
	return parts;
}

function otherMetadataParts(task: TaskLine): string[] {
	const parts: string[] = [];
	if (task.metadata.recurrence) parts.push(`${TASK_SYMBOLS.recurrence} ${task.metadata.recurrence}`);
	if (task.metadata.id) parts.push(`${TASK_SYMBOLS.id} ${task.metadata.id}`);
	if (task.metadata.onCompletion) parts.push(`${TASK_SYMBOLS.onCompletion} ${task.metadata.onCompletion}`);
	if (task.metadata.dependsOn) parts.push(`${TASK_SYMBOLS.dependsOn} ${task.metadata.dependsOn}`);
	if (task.metadata.blockLink) parts.push(task.metadata.blockLink);
	return parts;
}

function groupTasks(tasks: TaskListItem[], activeTab: TaskListTabId, collapsedGroups: Set<string>): TaskGroup[] {
	if (activeTab === "today") {
		const group: TaskGroup = {
			id: "today",
			title: t("taskTodo.group.today"),
			items: tasks,
			collapsed: collapsedGroups.has("today"),
		};
		return group.items.length > 0 ? [group] : [];
	}

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

function taskListTabs(): TaskListTab[] {
	return [
		{id: "in-plan", title: t("taskTodo.tab.inPlan")},
		{id: "today", title: t("taskTodo.tab.today")},
	];
}

function filterTasksForTab(tasks: TaskListItem[], activeTab: TaskListTabId): TaskListItem[] {
	return activeTab === "today" ? tasks.filter(isTodayTask) : tasks.filter(isInPlanTask);
}

function isInPlanTask(item: TaskListItem): boolean {
	return item.task.metadata.dates.scheduled !== null || item.task.metadata.dates.due !== null;
}

function isTodayTask(item: TaskListItem): boolean {
	const today = todayString();
	const {start, due, scheduled} = item.task.metadata.dates;
	if (scheduled === today || due === today) return true;
	if (!start || !due) return false;
	return start <= today && today <= due;
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

function isMarkdownFile(file: unknown): file is TFile {
	return Boolean(file && typeof file === "object" && "path" in file && "extension" in file && "basename" in file && "stat" in file);
}

function applyTaskStatusIcon(container: HTMLElement, statusType: TaskLine["status"]["type"]): void {
	container.empty();
	if (statusType === "DONE") {
		setIcon(container, "check");
		return;
	}
	if (statusType === "CANCELLED") {
		setIcon(container, "slash");
		return;
	}
	if (statusType === "IN_PROGRESS") {
		setIcon(container, "minus");
		return;
	}
}
