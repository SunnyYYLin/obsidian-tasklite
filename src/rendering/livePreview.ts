import type { App } from "obsidian";
import type { StatusRegistry } from "../model/status";
import type { TaskLiteSettings } from "../settings";
import { clickTaskCheckboxAtLine, rightClickTaskCheckboxAtLine, type ToggleResult } from "../editor/toggle";

interface EditorViewLike {
	dom: HTMLElement;
	posAtDOM(target: Node): number;
	state: {
		doc: {
			lineAt(position: number): {number: number};
			line(lineNumber: number): {from: number; to: number};
			toString(): string;
		};
		lineBreak: string;
	};
	dispatch(spec: {changes: {from: number; to: number; insert: string}}): void;
}

interface ViewPluginLike {
	fromClass(value: new (view: EditorViewLike) => {destroy(): void}): unknown;
}

type CheckboxMutation = (input: {
	lines: string[];
	lineNumber: number;
	metadata: ReturnType<App["metadataCache"]["getFileCache"]> | null;
	registry: StatusRegistry;
	settings: TaskLiteSettings;
}) => ToggleResult | null;

export function createLivePreviewExtension(app: App, registry: StatusRegistry, getSettings: () => TaskLiteSettings): unknown | null {
	const ViewPlugin = loadViewPlugin();
	if (!ViewPlugin) return null;

	return ViewPlugin.fromClass(
		class TaskLiteLivePreview {
			constructor(private readonly view: EditorViewLike) {
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
				this.view.dispatch({
					changes: {
						from,
						to: toLine.to,
						insert: result.replacement.join(this.view.state.lineBreak),
					},
				});
			}
		},
	);
}

function loadViewPlugin(): ViewPluginLike | null {
	try {
		const dynamicRequire = getRuntimeRequire();
		if (!dynamicRequire) return null;
		const moduleName = ["@codemirror", "view"].join("/");
		return dynamicRequire(moduleName)?.ViewPlugin ?? null;
	} catch {
		return null;
	}
}

function getRuntimeRequire(): ((id: string) => {ViewPlugin?: ViewPluginLike} | null | undefined) | null {
	const fromGlobal = (globalThis as {require?: unknown}).require;
	if (typeof fromGlobal === "function") return fromGlobal as (id: string) => {ViewPlugin?: ViewPluginLike} | null | undefined;
	return Function("return typeof require === 'function' ? require : null")() as
		| ((id: string) => {ViewPlugin?: ViewPluginLike} | null | undefined)
		| null;
}
