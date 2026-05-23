import { ViewPlugin, type EditorView, type PluginValue } from "@codemirror/view";
import type { App } from "obsidian";
import type { StatusRegistry } from "../model/status";
import type { TaskLiteSettings } from "../settings";
import { clickTaskCheckboxAtLine, rightClickTaskCheckboxAtLine, type ToggleResult } from "../editor/toggle";

type CheckboxMutation = (input: {
	lines: string[];
	lineNumber: number;
	metadata: ReturnType<App["metadataCache"]["getFileCache"]> | null;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
}) => ToggleResult | null;

export function createLivePreviewExtension(app: App, registry: StatusRegistry, getSettings: () => TaskLiteSettings) {
	return ViewPlugin.fromClass(
		class TaskLiteLivePreview implements PluginValue {
			constructor(private readonly view: EditorView) {
				this.view.dom.addEventListener("click", this.handleClick);
				this.view.dom.addEventListener("contextmenu", this.handleContextMenu);
			}

			destroy(): void {
				this.view.dom.removeEventListener("click", this.handleClick);
				this.view.dom.removeEventListener("contextmenu", this.handleContextMenu);
			}

			private handleClick = (event: MouseEvent): void => {
				this.applyCheckboxMutation(event, clickTaskCheckboxAtLine);
			};

			private handleContextMenu = (event: MouseEvent): void => {
				this.applyCheckboxMutation(event, rightClickTaskCheckboxAtLine);
			};

			private applyCheckboxMutation(event: MouseEvent, mutate: CheckboxMutation): void {
				const target = event.target;
				if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") return;
				const position = this.view.posAtDOM(target);
				const line = this.view.state.doc.lineAt(position);
				const activeFile = app.workspace.getActiveFile();
				const content = this.view.state.doc.toString();
				const lines = content.split(this.view.state.lineBreak);
				const result = mutate({
					lines,
					lineNumber: line.number - 1,
					metadata: activeFile ? app.metadataCache.getFileCache(activeFile) : null,
					registry,
					settings: getSettings(),
				});
				if (!result) return;

				event.preventDefault();
				event.stopPropagation();
				const from = this.view.state.doc.line(result.fromLine + 1).from;
				const toLine = this.view.state.doc.line(result.toLine + 1);
				const to = toLine.to;
				this.view.dispatch({
					changes: {
						from,
						to,
						insert: result.replacement.join(this.view.state.lineBreak),
					},
				});
			}
		},
	);
}
