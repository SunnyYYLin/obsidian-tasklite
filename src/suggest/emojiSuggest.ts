import { EditorSuggest, type Editor, type EditorPosition, type EditorSuggestContext, type EditorSuggestTriggerInfo, type TFile } from "obsidian";
import type TaskLitePlugin from "../main";
import { taskLineRegex, TASK_SYMBOLS } from "../model/format";
import { getDateSuggestions, parseDateShorthand, type DateSuggestionEntry } from "./dateShorthand";

// ---------------------------------------------------------------------------
// Emoji field suggestions (triggered by @)
// ---------------------------------------------------------------------------

interface EmojiSuggestion {
	kind: "emoji";
	label: string;
	insert: string;
}

interface DateSuggestion {
	kind: "date";
	entry: DateSuggestionEntry;
}

type Suggestion = EmojiSuggestion | DateSuggestion;

const EMOJI_SUGGESTIONS: EmojiSuggestion[] = [
	{kind: "emoji", label: "Due date / 截止日期", insert: `${TASK_SYMBOLS.due} `},
	{kind: "emoji", label: "Scheduled / 计划日期", insert: `${TASK_SYMBOLS.scheduled} `},
	{kind: "emoji", label: "Start / 开始日期", insert: `${TASK_SYMBOLS.start} `},
	{kind: "emoji", label: "Created / 创建日期", insert: `${TASK_SYMBOLS.created} `},
	{kind: "emoji", label: "Recurring / 循环", insert: `${TASK_SYMBOLS.recurrence} every `},
	{kind: "emoji", label: "Every day / 每天", insert: `${TASK_SYMBOLS.recurrence} every day`},
	{kind: "emoji", label: "Every weekday / 工作日", insert: `${TASK_SYMBOLS.recurrence} every weekday`},
	{kind: "emoji", label: "Every week / 每周", insert: `${TASK_SYMBOLS.recurrence} every week`},
	{kind: "emoji", label: "Every week on Monday / 每周一", insert: `${TASK_SYMBOLS.recurrence} every week on Monday`},
	{kind: "emoji", label: "Every week on Friday / 每周五", insert: `${TASK_SYMBOLS.recurrence} every week on Friday`},
	{kind: "emoji", label: "Every month / 每月", insert: `${TASK_SYMBOLS.recurrence} every month`},
	{kind: "emoji", label: "Every month on the 1st / 每月1号", insert: `${TASK_SYMBOLS.recurrence} every month on the 1st`},
	{kind: "emoji", label: "High priority / 高优先级", insert: TASK_SYMBOLS.priority.high},
	{kind: "emoji", label: "Medium priority / 中优先级", insert: TASK_SYMBOLS.priority.medium},
	{kind: "emoji", label: "Low priority / 低优先级", insert: TASK_SYMBOLS.priority.low},
	{kind: "emoji", label: "Task id / 任务 ID", insert: `${TASK_SYMBOLS.id} `},
	{kind: "emoji", label: "Depends on / 依赖", insert: `${TASK_SYMBOLS.dependsOn} `},
	{kind: "emoji", label: "On completion: keep / 完成后保留", insert: `${TASK_SYMBOLS.onCompletion} keep`},
	{kind: "emoji", label: "On completion: delete / 完成后删除", insert: `${TASK_SYMBOLS.onCompletion} delete`},
	{kind: "emoji", label: "Assignee / 负责人", insert: `${TASK_SYMBOLS.person} `},
];

/** Date emoji symbols that, when followed by a space and text, trigger date shorthand suggestions. */
const DATE_FIELD_SYMBOLS = [
	TASK_SYMBOLS.due,
	TASK_SYMBOLS.scheduled,
	TASK_SYMBOLS.start,
	TASK_SYMBOLS.created,
	TASK_SYMBOLS.done,
	TASK_SYMBOLS.cancelled,
];

// Regex that matches a date emoji symbol (with optional variation selector) followed by a space and the typed query
const DATE_FIELD_PATTERN = new RegExp(
	`(${DATE_FIELD_SYMBOLS.map(escapeRegex).join("|")})\\ufe0f? ([^\\s]*)$`,
	"u",
);

export class TaskLiteEmojiSuggest extends EditorSuggest<Suggestion> {
	constructor(private readonly plugin: TaskLitePlugin) {
		super(plugin.app);
	}

	onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
		if (!this.plugin.settings.autoSuggestInEditor || !file) return null;
		const line = editor.getLine(cursor.line);
		if (!taskLineRegex.test(line)) return null;
		const beforeCursor = line.slice(0, cursor.ch);

		// ----------------------------------------------------------------
		// Mode 1: @ triggers emoji field menu
		// ----------------------------------------------------------------
		const atIndex = Math.max(beforeCursor.lastIndexOf("@"), beforeCursor.lastIndexOf("＠"));
		if (atIndex >= 0) {
			return {
				start: {line: cursor.line, ch: atIndex},
				end: cursor,
				query: `@:${beforeCursor.slice(atIndex + 1).toLowerCase()}`,
			};
		}

		// ----------------------------------------------------------------
		// Mode 2: date emoji followed by text (or just a space) → date shorthand
		// ----------------------------------------------------------------
		const dateMatch = beforeCursor.match(DATE_FIELD_PATTERN);
		if (dateMatch) {
			const query = dateMatch[2] ?? "";
			const symbolStr = dateMatch[1] ?? "";
			const symbolEnd = beforeCursor.lastIndexOf(symbolStr);
			// queryStart = right after the space that follows the emoji
			const queryStart = symbolEnd + [...symbolStr].length + 1; // handle multi-codepoint emoji
			// Only trigger when cursor is right after the space or into the typed text
			if (cursor.ch >= queryStart) {
				return {
					start: {line: cursor.line, ch: queryStart},
					end: cursor,
					query: `date:${query.toLowerCase()}`,
				};
			}
		}

		return null;
	}

	getSuggestions(context: EditorSuggestContext): Suggestion[] {
		const {query} = context;

		// ---- emoji mode (@) ----
		if (query.startsWith("@:")) {
			const q = query.slice(2).trim();
			if (!q) return [];
			return EMOJI_SUGGESTIONS.filter((s) => s.label.toLowerCase().includes(q)).slice(0, 8);
		}

		// ---- date shorthand mode ----
		if (query.startsWith("date:")) {
			const q = query.slice(5).trim();
			if (!q) return [];
			const entries = getDateSuggestions(q, 8);
			return entries.map<DateSuggestion>((entry) => ({kind: "date", entry}));
		}

		return [];
	}

	renderSuggestion(value: Suggestion, el: HTMLElement): void {
		el.addClass("taskslite-suggest-item");
		if (value.kind === "emoji") {
			el.createSpan({text: value.insert.trim() || "…", cls: "taskslite-suggest-token"});
			el.createSpan({text: value.label});
		} else {
			// Show the resolved date prominently, then the human label
			el.createSpan({text: value.entry.resolved, cls: "taskslite-suggest-token"});
			el.createSpan({text: value.entry.localLabel});
		}
	}

	selectSuggestion(value: Suggestion): void {
		if (!this.context) return;
		if (value.kind === "emoji") {
			this.context.editor.replaceRange(value.insert, this.context.start, this.context.end);
		} else {
			// Write the resolved YYYY-MM-DD date into the note
			this.context.editor.replaceRange(value.entry.resolved, this.context.start, this.context.end);
		}
	}
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
