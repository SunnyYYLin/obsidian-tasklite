import { MarkdownRenderChild, MarkdownRenderer, type App, type MarkdownPostProcessorContext, type Plugin } from "obsidian";
import type { StatusRegistry } from "../model/status";
import { buildTaskTree, type TaskTreeNode } from "../model/tree";
import { serializeTaskBody } from "../model/format";
import type { TaskLiteSettings } from "../settings";
import { toggleFileTask } from "../editor/apply";

export class InlineTaskRenderer {
	constructor(
		private readonly plugin: Plugin,
		private readonly app: App,
		private readonly registry: StatusRegistry,
		private readonly getSettings: () => TaskLiteSettings,
	) {}

	register(): void {
		this.plugin.registerMarkdownPostProcessor((element, context) => {
			this.plugin.app.workspace.onLayoutReady(() => {
				void this.process(element, context);
			});
		});
	}

	private async process(element: HTMLElement, context: MarkdownPostProcessorContext): Promise<void> {
		const section = context.getSectionInfo(element);
		if (!section) return;
		const listItems = Array.from(element.querySelectorAll("li.task-list-item"));
		if (listItems.length === 0) return;

		const lines = section.text.split("\n");
		const tree = buildTaskTree(lines, this.app.metadataCache.getCache(context.sourcePath), this.registry);
		const child = new MarkdownRenderChild(element);
		context.addChild(child);

		for (const item of listItems) {
			const relativeLine = Number.parseInt(item.getAttribute("data-line") ?? "", 10);
			if (!Number.isFinite(relativeLine)) continue;
			const node = tree.byLine.get(section.lineStart + relativeLine) ?? tree.byLine.get(relativeLine);
			if (!node || !node.task) continue;
			await this.decorateTaskElement(item as HTMLLIElement, node, context.sourcePath, child);
		}
	}

	private async decorateTaskElement(li: HTMLLIElement, node: TaskTreeNode, path: string, child: MarkdownRenderChild): Promise<void> {
		if (!node.task) return;
		li.addClass("taskslite-task");
		li.dataset.task = node.task.status.symbol.trim();
		li.dataset.taskStatusName = node.task.status.name;
		li.dataset.taskStatusType = node.task.status.type;
		setData(li, "taskPriority", node.task.metadata.priority);
		setData(li, "taskStart", node.task.metadata.dates.start);
		setData(li, "taskScheduled", node.task.metadata.dates.scheduled);
		setData(li, "taskDue", node.task.metadata.dates.due);
		setData(li, "taskDone", node.task.metadata.dates.done);
		setData(li, "taskCancelled", node.task.metadata.dates.cancelled);

		const checkbox = li.querySelector<HTMLInputElement>("input.task-list-item-checkbox");
		if (checkbox) {
			checkbox.checked = node.task.status.symbol !== " ";
			checkbox.onclick = (event) => {
				event.preventDefault();
				event.stopPropagation();
				checkbox.disabled = true;
				void toggleFileTask({
					app: this.app,
					path,
					lineNumber: node.lineNumber,
					registry: this.registry,
					settings: this.getSettings(),
				});
			};
		}

		const textContainer = li.querySelector<HTMLElement>("p") ?? li;
		textContainer.addClass("taskslite-task-text");
		await this.renderDescription(node, textContainer, path, child);
	}

	private async renderDescription(node: TaskTreeNode, container: HTMLElement, path: string, child: MarkdownRenderChild): Promise<void> {
		if (!node.task) return;
		const checkbox = container.querySelector("input.task-list-item-checkbox");
		container.empty();
		if (checkbox) container.appendChild(checkbox);
		const span = container.createSpan({cls: "taskslite-description"});
		await MarkdownRenderer.render(this.app, node.task.metadata.description, span, path, child);
		const suffix = serializeTaskBody({...node.task.metadata, description: ""}).trim();
		if (suffix.length > 0) {
			container.createSpan({text: ` ${suffix}`, cls: "taskslite-metadata"});
		}
	}
}

function setData(element: HTMLElement, key: string, value: string | null): void {
	if (value) element.dataset[key] = value;
}
