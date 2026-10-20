import {
	Decoration,
	type DecorationSet,
	EditorView,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from "@codemirror/view";
import { RangeSetBuilder, type Extension } from "@codemirror/state";
import type { App } from "obsidian";

export const RECOGNIZED_TASK_KEYS = new Set([
	"due",
	"scheduled",
	"start",
	"created",
	"completion",
	"done",
	"cancelled",
	"remind",
	"priority",
	"repeat",
	"recurrence",
	"oncompletion",
	"dependson",
	"blockedby",
	"id",
	"assignee",
	"assigned",
	"person",
	"location",
	"place",
	"loc",
]);

interface ObsidianPluginsApp {
	plugins?: {
		plugins?: Record<string, unknown>;
		enabledPlugins?: Set<string>;
	};
}

export function isDataviewEnabled(app: App): boolean {
	const plugins = (app as unknown as ObsidianPluginsApp).plugins;
	return Boolean(plugins?.plugins?.["dataview"] && plugins.enabledPlugins?.has("dataview"));
}

export class InlineFieldWidget extends WidgetType {
	constructor(
		readonly key: string,
		readonly value: string,
		readonly rawText: string,
	) {
		super();
	}

	toDOM(): HTMLElement {
		const normKey = this.key.toLowerCase().trim();
		const span = document.createElement("span");
		span.className = "dataview inline-field tasklite-fallback";
		span.setAttribute("data-dv-key", normKey);
		span.setAttribute("data-dv-norm-key", normKey);
		span.setAttribute("data-dv-value", this.value.toLowerCase().trim());

		const keySpan = document.createElement("span");
		keySpan.className = "inline-field-key";
		keySpan.setAttribute("data-dv-key", normKey);
		keySpan.setAttribute("data-dv-norm-key", normKey);
		keySpan.textContent = this.key;

		const valSpan = document.createElement("span");
		valSpan.className = "inline-field-value";
		valSpan.textContent = this.value;

		span.appendChild(keySpan);
		span.appendChild(valSpan);
		return span;
	}

	eq(other: InlineFieldWidget): boolean {
		return other.key === this.key && other.value === this.value;
	}

	ignoreEvent(): boolean {
		return false;
	}
}

export const INLINE_FIELD_REGEX =
	/(?:\[|\()([a-zA-Z0-9_\u4e00-\u9fa5]+)::\s*([^\])]+?)(?:\]|\))/gu;

export function createInlineFieldFallbackExtension(app: App): Extension {
	return ViewPlugin.fromClass(
		class InlineFieldFallbackPlugin {
			decorations: DecorationSet;

			constructor(view: EditorView) {
				this.decorations = this.buildDecorations(view);
			}

			update(update: ViewUpdate): void {
				if (
					update.docChanged ||
					update.selectionSet ||
					update.viewportChanged
				) {
					this.decorations = this.buildDecorations(update.view);
				}
			}

			destroy(): void {}

			private buildDecorations(view: EditorView): DecorationSet {
				if (isDataviewEnabled(app)) {
					return Decoration.none;
				}

				const builder = new RangeSetBuilder<Decoration>();
				const selection = view.state.selection;

				for (const { from, to } of view.visibleRanges) {
					for (let pos = from; pos <= to; ) {
						const line = view.state.doc.lineAt(pos);
						const text = line.text;

						for (const match of text.matchAll(INLINE_FIELD_REGEX)) {
							const rawKey = match[1]?.trim() ?? "";
							const normKey = rawKey.toLowerCase();
							if (!RECOGNIZED_TASK_KEYS.has(normKey)) continue;

							const matchStart = line.from + (match.index ?? 0);
							const matchEnd = matchStart + match[0].length;

							const hasCursor = selection.ranges.some(
								(r) => r.to >= matchStart && r.from <= matchEnd,
							);
							if (hasCursor) continue;

							const val = match[2]?.trim() ?? "";
							builder.add(
								matchStart,
								matchEnd,
								Decoration.replace({
									widget: new InlineFieldWidget(rawKey, val, match[0]),
								}),
							);
						}
						pos = line.to + 1;
					}
				}

				return builder.finish();
			}
		},
		{
			decorations: (v) => v.decorations,
		},
	);
}

export function createInlineFieldPostProcessor(app: App) {
	return (el: HTMLElement): void => {
		if (isDataviewEnabled(app)) return;

		// 1. Process <a> tags created by Obsidian's link parser for [key:: val]
		const links = el.querySelectorAll("a.internal-link, a");
		links.forEach((a) => {
			const text = a.textContent ?? "";
			const match = text.match(/^([a-zA-Z0-9_\u4e00-\u9fa5]+)::\s*(.+)$/u);
			if (match) {
				const rawKey = match[1]?.trim() ?? "";
				const normKey = rawKey.toLowerCase();
				if (RECOGNIZED_TASK_KEYS.has(normKey)) {
					const val = match[2]?.trim() ?? "";
					const widget = new InlineFieldWidget(rawKey, val, text);
					a.replaceWith(widget.toDOM());
				}
			}
		});

		// 2. Process remaining plain text nodes containing [key:: val]
		const showTextFilter = typeof NodeFilter !== "undefined" ? NodeFilter.SHOW_TEXT : 4;
		const walker = document.createTreeWalker(el, showTextFilter);
		const nodesToReplace: { node: Text; parent: Node }[] = [];
		while (walker.nextNode()) {
			const node = walker.currentNode as Text;
			if (INLINE_FIELD_REGEX.test(node.nodeValue ?? "")) {
				INLINE_FIELD_REGEX.lastIndex = 0;
				if (node.parentNode) {
					nodesToReplace.push({ node, parent: node.parentNode });
				}
			}
		}

		for (const { node, parent } of nodesToReplace) {
			const text = node.nodeValue ?? "";
			const frag = document.createDocumentFragment();
			let lastIdx = 0;
			for (const match of text.matchAll(INLINE_FIELD_REGEX)) {
				const rawKey = match[1]?.trim() ?? "";
				const normKey = rawKey.toLowerCase();
				if (!RECOGNIZED_TASK_KEYS.has(normKey)) continue;

				const matchIdx = match.index ?? 0;
				if (matchIdx > lastIdx) {
					frag.appendChild(document.createTextNode(text.slice(lastIdx, matchIdx)));
				}
				const val = match[2]?.trim() ?? "";
				const widget = new InlineFieldWidget(rawKey, val, match[0]);
				frag.appendChild(widget.toDOM());
				lastIdx = matchIdx + match[0].length;
			}
			if (lastIdx < text.length) {
				frag.appendChild(document.createTextNode(text.slice(lastIdx)));
			}
			if (lastIdx > 0) {
				parent.replaceChild(frag, node);
			}
		}
	};
}
