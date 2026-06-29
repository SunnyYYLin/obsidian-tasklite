import { ViewPlugin, type EditorView, type PluginValue } from "@codemirror/view";
import { Notice, type App, type Plugin } from "obsidian";
import type { StatusRegistry } from "../model/status";
import type { TaskDocumentStore } from "../model/taskDocumentStore";
import type { TaskLiteSettings } from "../settings";
import { clickTaskCheckboxAtLine, rightClickTaskCheckboxAtLine, type ToggleResult } from "../editor/toggle";

type CheckboxMutation = (input: {
	lines: string[];
	lineNumber: number;
	metadata: ReturnType<App["metadataCache"]["getFileCache"]> | null;
	app: App;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
}) => ToggleResult | null;

export function createLivePreviewExtension(
	app: App,
	registry: StatusRegistry,
	getSettings: () => TaskLiteSettings,
	documentStore?: TaskDocumentStore,
): Parameters<Plugin["registerEditorExtension"]>[0] {
	return ViewPlugin.fromClass(
		class TaskLiteLivePreview implements PluginValue {
			constructor(private readonly view: EditorView) {
				this.view.dom.addEventListener("click", this.handleClick, true);
				this.view.dom.addEventListener("contextmenu", this.handleContextMenu, true);
			}

			destroy(): void {
				this.view.dom.removeEventListener("click", this.handleClick, true);
				this.view.dom.removeEventListener("contextmenu", this.handleContextMenu, true);
			}

			private handleClick = (event: MouseEvent): void => {
				this.applyCheckboxMutation(event, clickTaskCheckboxAtLine);
			};

			private handleContextMenu = (event: MouseEvent): void => {
				this.applyCheckboxMutation(event, rightClickTaskCheckboxAtLine);
			};

			private applyCheckboxMutation(event: MouseEvent, mutate: CheckboxMutation): void {
				const target = event.target;
				if (!(target instanceof HTMLInputElement) || target.type !== "checkbox" || !target.classList.contains("task-list-item-checkbox")) return;

				const position = this.view.posAtDOM(target);
				const line = this.view.state.doc.lineAt(position);
				const activeFile = app.workspace.getActiveFile();
				const content = this.view.state.doc.toString();
				const lines = content.split(this.view.state.lineBreak);
				const result = mutate({
					lines,
					lineNumber: line.number - 1,
					metadata: activeFile ? app.metadataCache.getFileCache(activeFile) : null,
					app,
					registry,
					settings: getSettings(),
				});
				if (!result) return;

				event.preventDefault();
				event.stopPropagation();
				event.stopImmediatePropagation();

				const from = this.view.state.doc.line(result.fromLine + 1).from;
				const toLine = this.view.state.doc.line(result.toLine + 1);
				this.view.dispatch({
					changes: {
						from,
						to: toLine.to,
						insert: result.replacement.join(this.view.state.lineBreak),
					},
				});
				if (activeFile) {
					void documentStore?.replaceDocumentContent(activeFile, this.view.state.doc.toString());
				}

				this.syncCheckboxDom(target, line.number);

				if (result.warning) {
					new Notice(result.warning);
				}
			}

			private syncCheckboxDom(target: HTMLInputElement, oneBasedLineNumber: number): void {
				const apply = (): void => {
					if (!target.isConnected) return;
					const text = this.view.state.doc.line(oneBasedLineNumber).text;
					const symbol = text.match(/\[(.)\]/u)?.[1] ?? " ";
					const statusConfig = registry.get(symbol);
					target.checked = statusConfig.type === "DONE";
					target.indeterminate = statusConfig.type === "IN_PROGRESS";
					target.dataset.task = symbol;
					target.setAttribute("data-task", symbol);
					const listItem = target.closest("li");
					listItem?.setAttribute("data-task", symbol);
				};
				this.view.requestMeasure({ read: () => null, write: apply });
				requestAnimationFrame(apply);
			}
		},
	);
}
