import { EditorSuggest, type Editor, type EditorPosition, type EditorSuggestContext, type EditorSuggestTriggerInfo, type TFile } from "obsidian";
import type TaskLitePlugin from "../main";
import { taskLineRegex, TASK_SYMBOLS } from "../model/format";
import { DATE_SHORTHAND_SUGGESTIONS, parseDateShorthand, type DateShorthandSuggestion } from "./dateShorthand";

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
	label: string;
	entry: DateShorthandSuggestion;
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
	{kind: "emoji", label: "Low priority / 低优先级", insert: TASK_SYMBOLS.priority.low},
	{kind: "emoji", label: "Task id / 任务 ID", insert: `${TASK_SYMBOLS.id} `},
	{kind: "emoji", label: "Depends on / 依赖", insert: `${TASK_SYMBOLS.dependsOn} `},
	{kind: "emoji", label: "On completion / 完成时", insert: `${TASK_SYMBOLS.onCompletion} `},
	{kind: "emoji", label: "On completion: keep / 保留", insert: `${TASK_SYMBOLS.onCompletion} keep`},
	{kind: "emoji", label: "On completion: delete / 删除", insert: `${TASK_SYMBOLS.onCompletion} delete`},
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
		// Mode 2: date emoji followed by text → date shorthand suggestions
		// ----------------------------------------------------------------
		const dateMatch = beforeCursor.match(DATE_FIELD_PATTERN);
		if (dateMatch) {
			const query = dateMatch[2] ?? "";
			const symbolEnd = beforeCursor.lastIndexOf(dateMatch[1] ?? "");
			const queryStart = symbolEnd + (dateMatch[1]?.length ?? 0) + 1; // +1 for the space
			if (query.length > 0) {
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
			const q = query.slice(2);
			if (!q) return EMOJI_SUGGESTIONS.slice(0, 8);
			return EMOJI_SUGGESTIONS.filter((s) => s.label.toLowerCase().includes(q)).slice(0, 8);
		}

		// ---- date shorthand mode ----
		if (query.startsWith("date:")) {
			const q = query.slice(5);
			// Show matching shorthand entries, plus any parseable free-form input
			const matched = DATE_SHORTHAND_SUGGESTIONS
				.filter((s) => s.label.toLowerCase().includes(q) || this.labelMatchesInput(q))
				.map<DateSuggestion>((entry) => ({kind: "date", label: entry.label, entry}))
				.slice(0, 8);

			// If the raw input resolves to a date, add it as first item
			if (q.length >= 3) {
				const resolved = parseDateShorthand(q);
				if (resolved) {
					const dynamic: DateSuggestion = {
						kind: "date",
						label: `"${q}" → ${resolved}`,
						entry: {label: q, resolve: () => resolved},
					};
					return [dynamic, ...matched.filter((m) => m.entry.resolve() !== resolved)].slice(0, 8);
				}
			}

			return matched;
		}

		return [];
	}

	renderSuggestion(value: Suggestion, el: HTMLElement): void {
		el.addClass("taskslite-suggest-item");
		if (value.kind === "emoji") {
			el.createSpan({text: value.insert, cls: "taskslite-suggest-token"});
			el.createSpan({text: value.label});
		} else {
			const resolved = value.entry.resolve();
			el.createSpan({text: resolved, cls: "taskslite-suggest-token"});
			el.createSpan({text: value.label});
		}
	}

	selectSuggestion(value: Suggestion): void {
		if (!this.context) return;
		if (value.kind === "emoji") {
			this.context.editor.replaceRange(value.insert, this.context.start, this.context.end);
		} else {
			// Insert the resolved date string
			this.context.editor.replaceRange(value.entry.resolve(), this.context.start, this.context.end);
		}
	}

	private labelMatchesInput(q: string): boolean {
		// Returns true only so we don't fully filter; individual entries are pre-filtered in getSuggestions
		return q.length > 0;
	}
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
