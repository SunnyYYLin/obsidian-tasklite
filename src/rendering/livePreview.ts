import { ViewPlugin, type EditorView, type PluginValue } from "@codemirror/view";
import type { App } from "obsidian";
import type { StatusRegistry } from "../model/status";
import type { TaskLiteSettings } from "../settings";
import { toggleTaskAtLine } from "../editor/toggle";

export function createLivePreviewExtension(app: App, registry: StatusRegistry, getSettings: () => TaskLiteSettings) {
	return ViewPlugin.fromClass(
		class TaskLiteLivePreview implements PluginValue {
			constructor(private readonly view: EditorView) {
				this.view.dom.addEventListener("click", this.handleClick);
			}

			destroy(): void {
				this.view.dom.removeEventListener("click", this.handleClick);
			}

			private handleClick = (event: MouseEvent): void => {
				const target = event.target;
				if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") return;
				const position = this.view.posAtDOM(target);
				const line = this.view.state.doc.lineAt(position);
				const activeFile = app.workspace.getActiveFile();
				const content = this.view.state.doc.toString();
				const lines = content.split(this.view.state.lineBreak);
				const result = toggleTaskAtLine({
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
			};
		},
	);
}
