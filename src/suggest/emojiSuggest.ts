import {
	EditorSuggest,
	type Editor,
	type EditorPosition,
	type EditorSuggestContext,
	type EditorSuggestTriggerInfo,
	type TFile,
} from "obsidian";
import type TaskLitePlugin from "../main";
import { taskLineRegex, TASK_SYMBOLS, parseLineWithStatus } from "../model/format";
import { generateSemanticId } from "../model/taskSemanticId";
import {
	getDateSuggestions,
	type DateSuggestionEntry,
} from "./dateShorthand";

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

interface DependsOnSuggestion {
	kind: "dependsOn";
	id: string;
	description: string;
}

interface AssigneeSuggestion {
	kind: "assignee";
	name: string;
}

type Suggestion = EmojiSuggestion | DateSuggestion | RecurrenceSuggestion | DependsOnSuggestion | AssigneeSuggestion;

const EMOJI_SUGGESTIONS: EmojiSuggestion[] = [
	{
		kind: "emoji",
		label: "Due date / 截止日期",
		insert: `${TASK_SYMBOLS.due} `,
	},
	{
		kind: "emoji",
		label: "Scheduled / 计划日期",
		insert: `${TASK_SYMBOLS.scheduled} `,
	},
	{
		kind: "emoji",
		label: "Start / 开始日期",
		insert: `${TASK_SYMBOLS.start} `,
	},
	{
		kind: "emoji",
		label: "Created / 创建日期",
		insert: `${TASK_SYMBOLS.created} `,
	},
	{
		kind: "emoji",
		label: "Recurring / 循环",
		insert: `${TASK_SYMBOLS.recurrence} `,
	},
	{
		kind: "emoji",
		label: "Highest priority / 最高优先级",
		insert: TASK_SYMBOLS.priority.highest,
	},
	{
		kind: "emoji",
		label: "High priority / 高优先级",
		insert: TASK_SYMBOLS.priority.high,
	},
	{
		kind: "emoji",
		label: "Medium priority / 中优先级",
		insert: TASK_SYMBOLS.priority.medium,
	},
	{
		kind: "emoji",
		label: "Low priority / 低优先级",
		insert: TASK_SYMBOLS.priority.low,
	},
	{
		kind: "emoji",
		label: "Lowest priority / 最低优先级",
		insert: TASK_SYMBOLS.priority.lowest,
	},
	{
		kind: "emoji",
		label: "Task id / 任务 ID",
		insert: `${TASK_SYMBOLS.id} `,
	},
	{
		kind: "emoji",
		label: "Depends on / 依赖",
		insert: `${TASK_SYMBOLS.dependsOn} `,
	},
	{
		kind: "emoji",
		label: "On completion: keep / 完成后保留",
		insert: `${TASK_SYMBOLS.onCompletion} keep`,
	},
	{
		kind: "emoji",
		label: "On completion: delete / 完成后删除",
		insert: `${TASK_SYMBOLS.onCompletion} delete`,
	},
	{
		kind: "emoji",
		label: "Assignee / 负责人",
		insert: `${TASK_SYMBOLS.assignee} `,
	},
	{
		kind: "emoji",
		label: "Remind / 提醒日期",
		insert: `${TASK_SYMBOLS.remind} `,
	},
];

const RECURRENCE_SUGGESTIONS: RecurrenceSuggestion[] = [
	{ kind: "recurrence", label: "Every day / 每天", insert: "every day" },
	{
		kind: "recurrence",
		label: "Every weekday / 工作日",
		insert: "every weekday",
	},
	{ kind: "recurrence", label: "Every week / 每周", insert: "every week" },
	{
		kind: "recurrence",
		label: "Every week on Monday / 每周一",
		insert: "every week on Monday",
	},
	{
		kind: "recurrence",
		label: "Every week on Friday / 每周五",
		insert: "every week on Friday",
	},
	{ kind: "recurrence", label: "Every month / 每月", insert: "every month" },
	{
		kind: "recurrence",
		label: "Every month on the 1st / 每月1号",
		insert: "every month on the 1st",
	},
	{ kind: "recurrence", label: "Every year / 每年", insert: "every year" },
];

/** Date emoji symbols that, when followed by a space and text, trigger date shorthand suggestions. */
const DATE_FIELD_SYMBOLS = [
	TASK_SYMBOLS.due,
	TASK_SYMBOLS.scheduled,
	TASK_SYMBOLS.start,
	TASK_SYMBOLS.created,
	TASK_SYMBOLS.done,
	TASK_SYMBOLS.cancelled,
	TASK_SYMBOLS.remind,
];

export class TaskLiteEmojiSuggest extends EditorSuggest<Suggestion> {
	constructor(private readonly plugin: TaskLitePlugin) {
		super(plugin.app);
	}

	onTrigger(
		cursor: EditorPosition,
		editor: Editor,
		file: TFile | null,
	): EditorSuggestTriggerInfo | null {
		if (!this.plugin.settings.autoSuggestInEditor || !file) return null;
		const line = editor.getLine(cursor.line);
		if (!taskLineRegex.test(line)) return null;
		const beforeCursor = line.slice(0, cursor.ch);

		// Find the last index of '@' or '＠'
		let atIndex = Math.max(
			beforeCursor.lastIndexOf("@"),
			beforeCursor.lastIndexOf("＠"),
		);

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

		// Find the last index of dependsOn symbol
		const dependsOnSymbol = TASK_SYMBOLS.dependsOn;
		const dependsOnIndex = beforeCursor.lastIndexOf(dependsOnSymbol);

		// Find the last index of assignee symbol
		const assigneeSymbol = TASK_SYMBOLS.assignee;
		const assigneeIndex = beforeCursor.lastIndexOf(assigneeSymbol);
		if (assigneeIndex !== -1 && atIndex > assigneeIndex) {
			atIndex = -1;
		}

		const maxIndex = Math.max(atIndex, lastDateSymbolIdx, recurrenceIndex, dependsOnIndex, assigneeIndex);
		if (maxIndex === -1) return null;

		if (maxIndex === atIndex) {
			// Mode 1: @ triggers emoji field menu
			const queryText = beforeCursor.slice(atIndex + 1);
			if (!containsDelimiter(queryText)) {
				return {
					start: { line: cursor.line, ch: atIndex },
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
					if (/^\d{4}-\d{2}-\d{2}/u.test(queryText)) {
						return null;
					}
					if (!containsDelimiter(queryText)) {
						return {
							start: { line: cursor.line, ch: queryStart },
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
					const trimmed = queryText.trim();
					const knownRules = ["every day", "every weekday", "every week", "every month", "every year"];
					if (knownRules.includes(trimmed) || /^every\s+\d+\s+(?:days?|weeks?|months?|years?)$/u.test(trimmed)) {
						return null;
					}
					if (!containsDelimiter(queryText)) {
						return {
							start: { line: cursor.line, ch: queryStart },
							end: cursor,
							query: `recur:${queryText.toLowerCase()}`,
						};
					}
				}
			}
		} else if (maxIndex === dependsOnIndex) {
			// Mode 4: dependsOn emoji followed by space -> dependsOn ID suggestions
			const afterSymbolIdx = dependsOnIndex + dependsOnSymbol.length;
			if (beforeCursor.charAt(afterSymbolIdx) === " ") {
				const queryStart = afterSymbolIdx + 1;
				if (cursor.ch >= queryStart) {
					const queryText = beforeCursor.slice(queryStart);
					const trimmed = queryText.trim();
					const existingIds = new Set<string>();
					for (const r of this.plugin.documentStore.listCachedRecords()) {
						if (r.task.id) {
							existingIds.add(r.task.id);
						}
					}
					if (existingIds.has(trimmed)) {
						return null;
					}
					if (!containsDelimiter(queryText)) {
						return {
							start: { line: cursor.line, ch: queryStart },
							end: cursor,
							query: `depends:${queryText.toLowerCase()}`,
						};
					}
				}
			}
		} else if (maxIndex === assigneeIndex) {
			// Mode 5: assignee emoji followed by space -> assignee suggestions
			const afterSymbolIdx = assigneeIndex + assigneeSymbol.length;
			if (beforeCursor.charAt(afterSymbolIdx) === " ") {
				let queryStart = afterSymbolIdx + 1;
				const fieldText = beforeCursor.slice(queryStart);
				
				// Support multi-assignee separated by & or -.
				const lastSeparatorIdx = Math.max(
					fieldText.lastIndexOf("&"),
					fieldText.lastIndexOf("-"),
				);
				if (lastSeparatorIdx !== -1) {
					queryStart += lastSeparatorIdx + 1;
				}
				
				// Strip leading spaces
				while (queryStart < cursor.ch && beforeCursor.charAt(queryStart) === " ") {
					queryStart++;
				}

				if (cursor.ch >= queryStart) {
					const queryText = beforeCursor.slice(queryStart);
					const trimmed = queryText.trim();
					const assignees = new Set(this.plugin.settings.assignees || []);
					if (assignees.has(trimmed)) {
						return null;
					}
					if (!containsAssigneeDelimiter(queryText)) {
						return {
							start: { line: cursor.line, ch: queryStart },
							end: cursor,
							query: `assignee:${queryText.toLowerCase()}`,
						};
					}
				}
			}
		}

		return null;
	}

	getSuggestions(context: EditorSuggestContext): Suggestion[] {
		const { query } = context;

		// ---- emoji mode (@) ----
		if (query.startsWith("@:")) {
			const q = query.slice(2).trim();
			if (!q) return EMOJI_SUGGESTIONS.slice(0, 8);
			return EMOJI_SUGGESTIONS.filter((s) =>
				s.label.toLowerCase().includes(q),
			).slice(0, 8);
		}

		// ---- date shorthand mode ----
		if (query.startsWith("date:")) {
			const q = query.slice(5).trim();
			if (!q) return [];
			const entries = getDateSuggestions(q, 8);
			return entries.map<DateSuggestion>((entry) => ({
				kind: "date",
				entry,
			}));
		}

		// ---- recurrence shorthand mode ----
		if (query.startsWith("recur:")) {
			const q = query.slice(6).trim();
			if (!q) return RECURRENCE_SUGGESTIONS.slice(0, 8);
			return RECURRENCE_SUGGESTIONS.filter(
				(s) =>
					s.label.toLowerCase().includes(q) ||
					s.insert.toLowerCase().includes(q),
			).slice(0, 8);
		}

		// ---- dependsOn autocomplete mode ----
		if (query.startsWith("depends:")) {
			const q = query.slice(8).trim();
			const records = this.plugin.documentStore.listCachedRecords();
			const ids = new Map<string, string>(); // id -> description
			for (const r of records) {
				if (r.task.id) {
					ids.set(r.task.id, r.task.description);
				}
			}
			const matches: DependsOnSuggestion[] = [];
			for (const [id, desc] of ids.entries()) {
				if (!q || id.toLowerCase().includes(q) || desc.toLowerCase().includes(q)) {
					matches.push({
						kind: "dependsOn",
						id,
						description: desc,
					});
				}
			}
			return matches.slice(0, 8);
		}

		// ---- assignee autocomplete mode ----
		if (query.startsWith("assignee:")) {
			const q = query.slice(9).trim();
			const assignees = this.plugin.settings.assignees || [];
			const matches: AssigneeSuggestion[] = [];
			for (const name of assignees) {
				if (!q || name.toLowerCase().includes(q)) {
					matches.push({
						kind: "assignee",
						name,
					});
				}
			}
			return matches.slice(0, 8);
		}

		return [];
	}

	renderSuggestion(value: Suggestion, el: HTMLElement): void {
		el.addClass("taskslite-suggest-item");
		if (value.kind === "emoji") {
			el.createSpan({
				text: value.insert.trim() || "…",
				cls: "taskslite-suggest-token",
			});
			el.createSpan({ text: value.label });
		} else if (value.kind === "recurrence") {
			el.createSpan({
				text: value.insert,
				cls: "taskslite-suggest-token",
			});
			el.createSpan({ text: value.label });
		} else if (value.kind === "dependsOn") {
			el.createSpan({
				text: value.id,
				cls: "taskslite-suggest-token",
			});
			el.createSpan({ text: value.description });
		} else if (value.kind === "assignee") {
			el.createSpan({
				text: value.name,
				cls: "taskslite-suggest-token",
			});
		} else {
			// Only show "text -> replacement text"
			el.createSpan({ text: value.entry.localLabel });
		}
	}

	selectSuggestion(value: Suggestion): void {
		if (!this.context) return;
		let insertedText = "";
		if (value.kind === "emoji") {
			let insertText = value.insert;
			if (value.insert === `${TASK_SYMBOLS.id} `) {
				const line = this.context.editor.getLine(this.context.start.line);
				const beforeTrigger = line.slice(0, this.context.start.ch);
				const afterTrigger = line.slice(this.context.end.ch);
				const cleanLine = (beforeTrigger + afterTrigger).trim();

				const parsed = parseLineWithStatus(cleanLine, this.plugin.statusRegistry);
				const description = parsed?.data.description ?? cleanLine.replace(/^[\s\t>]*([-*+]|[0-9]+[.)])( +\[.\])? */u, "").trim();
				const isRecurring = !!parsed?.data.recurrence;
				const dueDate = parsed?.data.dates.due ?? null;

				const existingIds = new Set<string>();
				for (const r of this.plugin.documentStore.listCachedRecords()) {
					if (r.task.id) {
						existingIds.add(r.task.id);
					}
				}

				const semanticId = generateSemanticId(description, {
					isRecurring,
					dueDate,
					existingIds,
				});
				insertText = `${TASK_SYMBOLS.id} ${semanticId} `;
			}
			insertedText = insertText;
		} else if (value.kind === "recurrence") {
			insertedText = value.insert;
		} else if (value.kind === "dependsOn") {
			insertedText = value.id;
		} else if (value.kind === "assignee") {
			insertedText = value.name;
		} else {
			insertedText = value.entry.resolved;
		}

		this.context.editor.replaceRange(
			insertedText,
			this.context.start,
			this.context.end,
		);

		// Explicitly move cursor to the end of the replaced range
		const newCursor = {
			line: this.context.start.line,
			ch: this.context.start.ch + insertedText.length,
		};
		this.context.editor.setCursor(newCursor);
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
		TASK_SYMBOLS.assignee,
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

function containsAssigneeDelimiter(text: string): boolean {
	if (text.includes("#")) {
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
		TASK_SYMBOLS.assignee,
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

