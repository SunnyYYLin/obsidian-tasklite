import { EditorSuggest, type Editor, type EditorPosition, type EditorSuggestContext, type EditorSuggestTriggerInfo, type TFile } from "obsidian";
import type TaskLitePlugin from "../main";
import { taskLineRegex, TASK_SYMBOLS } from "../model/format";

interface EmojiSuggestion {
	label: string;
	insert: string;
}

const SUGGESTIONS: EmojiSuggestion[] = [
	{label: "Due date / 截止日期", insert: `${TASK_SYMBOLS.due} `},
	{label: "Scheduled / 计划日期", insert: `${TASK_SYMBOLS.scheduled} `},
	{label: "Start / 开始日期", insert: `${TASK_SYMBOLS.start} `},
	{label: "Created / 创建日期", insert: `${TASK_SYMBOLS.created} `},
	{label: "Recurring / 循环", insert: `${TASK_SYMBOLS.recurrence} every `},
	{label: "Every day / 每天", insert: `${TASK_SYMBOLS.recurrence} every day`},
	{label: "Every weekday / 工作日", insert: `${TASK_SYMBOLS.recurrence} every weekday`},
	{label: "Every week / 每周", insert: `${TASK_SYMBOLS.recurrence} every week`},
	{label: "Every week on Monday / 每周一", insert: `${TASK_SYMBOLS.recurrence} every week on Monday`},
	{label: "Every week on Friday / 每周五", insert: `${TASK_SYMBOLS.recurrence} every week on Friday`},
	{label: "Every month / 每月", insert: `${TASK_SYMBOLS.recurrence} every month`},
	{label: "Every month on the 1st / 每月1号", insert: `${TASK_SYMBOLS.recurrence} every month on the 1st`},
	{label: "High priority / 高优先级", insert: TASK_SYMBOLS.priority.high},
	{label: "Low priority / 低优先级", insert: TASK_SYMBOLS.priority.low},
	{label: "Task id / 任务 ID", insert: `${TASK_SYMBOLS.id} `},
	{label: "Depends on / 依赖", insert: `${TASK_SYMBOLS.dependsOn} `},
	{label: "On completion / 完成时", insert: `${TASK_SYMBOLS.onCompletion} `},
	{label: "On completion: keep / 保留", insert: `${TASK_SYMBOLS.onCompletion} keep`},
	{label: "On completion: delete / 删除", insert: `${TASK_SYMBOLS.onCompletion} delete`},
];

export class TaskLiteEmojiSuggest extends EditorSuggest<EmojiSuggestion> {
	constructor(private readonly plugin: TaskLitePlugin) {
		super(plugin.app);
	}

	onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
		if (!this.plugin.settings.autoSuggestInEditor || !file) return null;
		const line = editor.getLine(cursor.line);
		if (!taskLineRegex.test(line)) return null;
		const beforeCursor = line.slice(0, cursor.ch);
		const triggerIndex = Math.max(beforeCursor.lastIndexOf("@"), beforeCursor.lastIndexOf("＠"));
		if (triggerIndex < 0) return null;
		return {
			start: {line: cursor.line, ch: triggerIndex},
			end: cursor,
			query: beforeCursor.slice(triggerIndex + 1).toLowerCase(),
		};
	}

	getSuggestions(context: EditorSuggestContext): EmojiSuggestion[] {
		if (!context.query) return SUGGESTIONS.slice(0, 8);
		return SUGGESTIONS.filter((suggestion) => suggestion.label.toLowerCase().includes(context.query)).slice(0, 8);
	}

	renderSuggestion(value: EmojiSuggestion, el: HTMLElement): void {
		el.addClass("taskslite-suggest-item");
		el.createSpan({text: value.insert, cls: "taskslite-suggest-token"});
		el.createSpan({text: value.label});
	}

	selectSuggestion(value: EmojiSuggestion): void {
		if (!this.context) return;
		this.context.editor.replaceRange(value.insert, this.context.start, this.context.end);
	}
}
