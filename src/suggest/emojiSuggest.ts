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

interface RecurrenceSuggestion {
	kind: "recurrence";
	label: string;
	insert: string;
}

type Suggestion = EmojiSuggestion | DateSuggestion | RecurrenceSuggestion;

const EMOJI_SUGGESTIONS: EmojiSuggestion[] = [
	{kind: "emoji", label: "Due date / 截止日期", insert: `${TASK_SYMBOLS.due} `},
	{kind: "emoji", label: "Scheduled / 计划日期", insert: `${TASK_SYMBOLS.scheduled} `},
	{kind: "emoji", label: "Start / 开始日期", insert: `${TASK_SYMBOLS.start} `},
	{kind: "emoji", label: "Created / 创建日期", insert: `${TASK_SYMBOLS.created} `},
	{kind: "emoji", label: "Recurring / 循环", insert: `${TASK_SYMBOLS.recurrence} `},
	{kind: "emoji", label: "High priority / 高优先级", insert: TASK_SYMBOLS.priority.high},
	{kind: "emoji", label: "Medium priority / 中优先级", insert: TASK_SYMBOLS.priority.medium},
	{kind: "emoji", label: "Low priority / 低优先级", insert: TASK_SYMBOLS.priority.low},
	{kind: "emoji", label: "Task id / 任务 ID", insert: `${TASK_SYMBOLS.id} `},
	{kind: "emoji", label: "Depends on / 依赖", insert: `${TASK_SYMBOLS.dependsOn} `},
	{kind: "emoji", label: "On completion: keep / 完成后保留", insert: `${TASK_SYMBOLS.onCompletion} keep`},
	{kind: "emoji", label: "On completion: delete / 完成后删除", insert: `${TASK_SYMBOLS.onCompletion} delete`},
	{kind: "emoji", label: "Assignee / 负责人", insert: `${TASK_SYMBOLS.person} `},
];

const RECURRENCE_SUGGESTIONS: RecurrenceSuggestion[] = [
	{kind: "recurrence", label: "Every day / 每天", insert: "every day"},
	{kind: "recurrence", label: "Every weekday / 工作日", insert: "every weekday"},
	{kind: "recurrence", label: "Every week / 每周", insert: "every week"},
	{kind: "recurrence", label: "Every week on Monday / 每周一", insert: "every week on Monday"},
	{kind: "recurrence", label: "Every week on Friday / 每周五", insert: "every week on Friday"},
	{kind: "recurrence", label: "Every month / 每月", insert: "every month"},
	{kind: "recurrence", label: "Every month on the 1st / 每月1号", insert: "every month on the 1st"},
	{kind: "recurrence", label: "Every year / 每年", insert: "every year"},
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

export class TaskLiteEmojiSuggest extends EditorSuggest<Suggestion> {
	constructor(private readonly plugin: TaskLitePlugin) {
		super(plugin.app);
	}

	onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
		if (!this.plugin.settings.autoSuggestInEditor || !file) return null;
		const line = editor.getLine(cursor.line);
		if (!taskLineRegex.test(line)) return null;
		const beforeCursor = line.slice(0, cursor.ch);

		// Find the last index of '@' or '＠'
		const atIndex = Math.max(beforeCursor.lastIndexOf("@"), beforeCursor.lastIndexOf("＠"));

		// Find the last index of any date symbol
		let lastDateSymbol: string | null = null;
		let lastDateSymbolIdx = -1;
		for (const symbol of DATE_FIELD_SYMBOLS) {
			const idx = beforeCursor.lastIndexOf(symbol);
			if (idx > lastDateSymbolIdx) {
				lastDateSymbolIdx = idx;
				lastDateSymbol = symbol;
			}
		}

		// Find the last index of recurrence symbol
		const recurrenceSymbol = TASK_SYMBOLS.recurrence;
		const recurrenceIndex = beforeCursor.lastIndexOf(recurrenceSymbol);

		const maxIndex = Math.max(atIndex, lastDateSymbolIdx, recurrenceIndex);
		if (maxIndex === -1) return null;

		if (maxIndex === atIndex) {
			// Mode 1: @ triggers emoji field menu
			const queryText = beforeCursor.slice(atIndex + 1);
			if (!containsDelimiter(queryText)) {
				return {
					start: {line: cursor.line, ch: atIndex},
					end: cursor,
					query: `@:${queryText.toLowerCase()}`,
				};
			}
		} else if (maxIndex === lastDateSymbolIdx && lastDateSymbol !== null) {
			// Mode 2: date emoji followed by space -> date shorthand
			const afterSymbolIdx = lastDateSymbolIdx + lastDateSymbol.length;
			if (beforeCursor.charAt(afterSymbolIdx) === " ") {
				const queryStart = afterSymbolIdx + 1;
				if (cursor.ch >= queryStart) {
					const queryText = beforeCursor.slice(queryStart);
					if (!containsDelimiter(queryText)) {
						return {
							start: {line: cursor.line, ch: queryStart},
							end: cursor,
							query: `date:${queryText.toLowerCase()}`,
						};
					}
				}
			}
		} else if (maxIndex === recurrenceIndex) {
			// Mode 3: recurrence emoji followed by space -> recurrence shorthand
			const afterSymbolIdx = recurrenceIndex + recurrenceSymbol.length;
			if (beforeCursor.charAt(afterSymbolIdx) === " ") {
				const queryStart = afterSymbolIdx + 1;
				if (cursor.ch >= queryStart) {
					const queryText = beforeCursor.slice(queryStart);
					if (!containsDelimiter(queryText)) {
						return {
							start: {line: cursor.line, ch: queryStart},
							end: cursor,
							query: `recur:${queryText.toLowerCase()}`,
						};
					}
				}
			}
		}

		return null;
	}

	getSuggestions(context: EditorSuggestContext): Suggestion[] {
		const {query} = context;

		// ---- emoji mode (@) ----
		if (query.startsWith("@:")) {
			const q = query.slice(2).trim();
			if (!q) return EMOJI_SUGGESTIONS.slice(0, 8);
			return EMOJI_SUGGESTIONS.filter((s) => s.label.toLowerCase().includes(q)).slice(0, 8);
		}

		// ---- date shorthand mode ----
		if (query.startsWith("date:")) {
			const q = query.slice(5).trim();
			if (!q) return [];
			const entries = getDateSuggestions(q, 8);
			return entries.map<DateSuggestion>((entry) => ({kind: "date", entry}));
		}

		// ---- recurrence shorthand mode ----
		if (query.startsWith("recur:")) {
			const q = query.slice(6).trim();
			if (!q) return RECURRENCE_SUGGESTIONS.slice(0, 8);
			return RECURRENCE_SUGGESTIONS.filter((s) => s.label.toLowerCase().includes(q) || s.insert.toLowerCase().includes(q)).slice(0, 8);
		}

		return [];
	}

	renderSuggestion(value: Suggestion, el: HTMLElement): void {
		el.addClass("taskslite-suggest-item");
		if (value.kind === "emoji") {
			el.createSpan({text: value.insert.trim() || "…", cls: "taskslite-suggest-token"});
			el.createSpan({text: value.label});
		} else if (value.kind === "recurrence") {
			el.createSpan({text: value.insert, cls: "taskslite-suggest-token"});
			el.createSpan({text: value.label});
		} else {
			// Only show "text -> replacement text"
			el.createSpan({text: value.entry.localLabel});
		}
	}

	selectSuggestion(value: Suggestion): void {
		if (!this.context) return;
		if (value.kind === "emoji") {
			this.context.editor.replaceRange(value.insert, this.context.start, this.context.end);
		} else if (value.kind === "recurrence") {
			this.context.editor.replaceRange(value.insert, this.context.start, this.context.end);
		} else {
			// Write the resolved YYYY-MM-DD date into the note
			this.context.editor.replaceRange(value.entry.resolved, this.context.start, this.context.end);
		}
	}
}

function containsDelimiter(text: string): boolean {
	if (text.includes("#") || text.includes("@") || text.includes("＠")) {
		return true;
	}
	const symbols = [
		TASK_SYMBOLS.due,
		TASK_SYMBOLS.scheduled,
		TASK_SYMBOLS.start,
		TASK_SYMBOLS.created,
		TASK_SYMBOLS.done,
		TASK_SYMBOLS.cancelled,
		TASK_SYMBOLS.recurrence,
		TASK_SYMBOLS.onCompletion,
		TASK_SYMBOLS.dependsOn,
		TASK_SYMBOLS.id,
		TASK_SYMBOLS.person,
		TASK_SYMBOLS.priority.highest,
		TASK_SYMBOLS.priority.high,
		TASK_SYMBOLS.priority.medium,
		TASK_SYMBOLS.priority.low,
		TASK_SYMBOLS.priority.lowest,
	];
	for (const sym of symbols) {
		if (text.includes(sym)) return true;
	}
	return false;
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
