import { describe, expect, test, mock } from "bun:test";

mock.module("obsidian", () => {
	class TFile {
		path: string = "";
		basename: string = "";
		extension: string = "md";
	}
	class Notice {
		constructor(message: string) {
			console.log("Mock Notice:", message);
		}
	}
	class EditorSuggest {
		constructor(app: any) {}
	}
	class PluginSettingTab {
		constructor(app: any, plugin: any) {}
	}
	class Setting {
		constructor(containerEl: any) {}
		setName() { return this; }
		setDesc() { return this; }
		setHeading() { return this; }
		addText() { return this; }
		addTextArea() { return this; }
		addToggle() { return this; }
		addDropdown() { return this; }
		addButton() { return this; }
	}
	return {
		TFile,
		Notice,
		EditorSuggest,
		PluginSettingTab,
		Setting,
	};
});

import { parseTaskLine, parseLineWithStatus, serializeTaskLine, TASK_SYMBOLS, normalizeLineIndentation, type TaskPriority } from "../src/model/format";
import { StatusRegistry } from "../src/model/status";
import { buildTaskTree } from "../src/model/tree";
import { taskIdentityKey } from "../src/model/taskIdentity";
import { TaskDocumentStore, type TaskDocumentRecord } from "../src/model/taskDocumentStore";
import { filterTaskRecordsByQuery, doesQueryExcludeCompleted } from "../src/model/taskQuery";
import { cancelTaskAtLine, clickTaskCheckboxAtLine, rightClickTaskCheckboxAtLine, toggleTaskAtLine, unfinishTaskAtLine } from "../src/editor/toggle";
import { reconcileExternalTaskCompletion } from "../src/editor/externalReconcileCore";
import { generateSemanticId } from "../src/model/taskSemanticId";
import { createTaskLiteCoreApi } from "../src/api/taskLiteCoreApi";
import { normalizeVaultTaskFormat } from "../src/editor/formatNormalization";
import type TaskLitePlugin from "../src/main";
import type { TaskLiteSettings } from "../src/settings";
import type { CachedMetadata, ListItemCache } from "obsidian";

interface FakeMoment {
	format(format: "YYYY-MM-DD"): string;
	isValid(): boolean;
}

type FakeMomentFactory = (value?: string, format?: string, strict?: boolean) => FakeMoment;

const fakeMoment: FakeMomentFactory = (value?: string) => {
	const date = value ? parseDate(value) : new Date(Date.UTC(2026, 4, 16));
	return {
		format: () => formatDate(date),
		isValid: () => !Number.isNaN(date.getTime()),
	};
};

(globalThis as unknown as {window: {moment: FakeMomentFactory}}).window = {moment: fakeMoment};

const settings: TaskLiteSettings = {
	preferredTaskFormat: "emoji",
	setCreatedDate: false,
	setDoneDate: true,
	setCancelledDate: true,
	copySubtasksOnRecurrence: true,
	autoSuggestInEditor: true,
	toggleBehavior: {
		cascadeFinish: true,
		cascadeCancel: true,
		cascadeUnfinish: false,
		cascadeUncancel: true,
		parentOnFinish: true,
		parentOnCancel: true,
		parentOnUnfinish: true,
		parentOnUncancel: true,
	},
};

describe("TaskLite core", () => {
	test("parses Tasks-compatible emoji metadata", () => {
		const registry = new StatusRegistry();
		const task = parseTaskLine(`- [ ] Ship MVP ${TASK_SYMBOLS.due} 2026-05-20 ${TASK_SYMBOLS.recurrence} every week`, registry.get(" "));

		expect(task?.data.description).toBe("Ship MVP");
		expect(task?.data.dates.due).toBe("2026-05-20");
		expect(task?.data.recurrence).toBe("every week");
	});

	test("supports every weekday recurrence", () => {
		const registry = new StatusRegistry();
		// 2026-05-29 is Friday, next weekday is Monday 2026-06-01
		const result = toggleTaskAtLine({
			lines: [`- [ ] Daily standup ${TASK_SYMBOLS.due} 2026-05-29 ${TASK_SYMBOLS.recurrence} every weekday`],
			lineNumber: 0,
			metadata: null,
			registry,
			settings,
		});

		expect(result?.replacement[0]).toContain(`${TASK_SYMBOLS.due} 2026-06-01`);
	});

	test("supports every week on specific day recurrence", () => {
		const registry = new StatusRegistry();
		// 2026-05-25 is Monday, every week on Wednesday → 2026-05-27
		const result = toggleTaskAtLine({
			lines: [`- [ ] Meeting ${TASK_SYMBOLS.due} 2026-05-25 ${TASK_SYMBOLS.recurrence} every week on Wednesday`],
			lineNumber: 0,
			metadata: null,
			registry,
			settings,
		});

		expect(result?.replacement[0]).toContain(`${TASK_SYMBOLS.due} 2026-05-27`);
	});

	test("supports every month on the Nth recurrence", () => {
		const registry = new StatusRegistry();
		// Due on the 15th, every month on the 15th → next is 2026-06-15
		const result = toggleTaskAtLine({
			lines: [`- [ ] Report ${TASK_SYMBOLS.due} 2026-05-15 ${TASK_SYMBOLS.recurrence} every month on the 15th`],
			lineNumber: 0,
			metadata: null,
			registry,
			settings,
		});

		expect(result?.replacement[0]).toContain(`${TASK_SYMBOLS.due} 2026-06-15`);
	});

	test("supports recurrence with times and remind dates", () => {
		const registry = new StatusRegistry();
		// Due on 2026-05-29 10:00 AM, Remind on 2026-05-28 6:00 PM, recur every day
		// Next due should be 2026-05-30 10:00 AM
		// Next remind should be 2026-05-29 6:00 PM
		const result = toggleTaskAtLine({
			lines: [`- [ ] Standup ${TASK_SYMBOLS.due} 2026-05-29 10:00 AM ${TASK_SYMBOLS.remind} 2026-05-28 6:00 PM ${TASK_SYMBOLS.recurrence} every day`],
			lineNumber: 0,
			metadata: null,
			registry,
			settings,
		});

		expect(result?.replacement[0]).toContain(`${TASK_SYMBOLS.due} 2026-05-30 10:00 AM`);
		expect(result?.replacement[0]).toContain(`${TASK_SYMBOLS.remind} 2026-05-29 6:00 PM`);
	});

	test("toggles status and adds a done date", () => {
		const registry = new StatusRegistry();
		const result = toggleTaskAtLine({
			lines: ["- [ ] Ship MVP"],
			lineNumber: 0,
			metadata: null,
			registry,
			settings,
		});

		expect(result?.replacement[0]).toContain("- [x] Ship MVP");
		expect(result?.replacement[0]).toContain(TASK_SYMBOLS.done);
	});

	test("creates a recurring parent with copied subtasks", () => {
		const registry = new StatusRegistry();
		const result = toggleTaskAtLine({
			lines: [
				`- [ ] Parent ${TASK_SYMBOLS.due} 2026-05-20 ${TASK_SYMBOLS.recurrence} every week`,
				`  - [x] Child done ${TASK_SYMBOLS.done} 2026-05-19 ${TASK_SYMBOLS.id} abc`,
				"  - plain note",
				"- [ ] Sibling",
			],
			lineNumber: 0,
			metadata: null,
			registry,
			settings,
		});

		expect(result?.replacement).toEqual([
			`- [ ] Parent ${TASK_SYMBOLS.due} 2026-05-27 ${TASK_SYMBOLS.recurrence} every week`,
			"  - [ ] Child done",
			"  - plain note",
			expect.stringContaining(`- [x] Parent ${TASK_SYMBOLS.due} 2026-05-20`),
			expect.stringContaining("  - [x] Child done"),
			"  - plain note",
		]);
	});

	test("bases when done recurrence on the completion date", () => {
		const registry = new StatusRegistry();
		const result = toggleTaskAtLine({
			lines: [
				`- [ ] Parent ${TASK_SYMBOLS.due} 2026-05-10 ${TASK_SYMBOLS.recurrence} every day when done`,
			],
			lineNumber: 0,
			metadata: null,
			registry,
			settings,
		});

		expect(result?.replacement[0]).toContain(`${TASK_SYMBOLS.due} 2026-05-17`);
		expect(result?.replacement[1]).toContain(`${TASK_SYMBOLS.due} 2026-05-10`);
	});

	test("keeps start and scheduled dates relative to the due date", () => {
		const registry = new StatusRegistry();
		const result = toggleTaskAtLine({
			lines: [
				`- [ ] Parent ${TASK_SYMBOLS.start} 2026-05-01 ${TASK_SYMBOLS.scheduled} 2026-05-03 ${TASK_SYMBOLS.due} 2026-05-10 ${TASK_SYMBOLS.recurrence} every week`,
			],
			lineNumber: 0,
			metadata: null,
			registry,
			settings,
		});

		expect(result?.replacement[0]).toContain(`${TASK_SYMBOLS.start} 2026-05-08`);
		expect(result?.replacement[0]).toContain(`${TASK_SYMBOLS.scheduled} 2026-05-10`);
		expect(result?.replacement[0]).toContain(`${TASK_SYMBOLS.due} 2026-05-17`);
	});

	test("clamps monthly recurrence at the end of shorter months", () => {
		const registry = new StatusRegistry();
		const result = toggleTaskAtLine({
			lines: [
				`- [ ] Parent ${TASK_SYMBOLS.due} 2026-01-31 ${TASK_SYMBOLS.recurrence} every month`,
			],
			lineNumber: 0,
			metadata: null,
			registry,
			settings,
		});

		expect(result?.replacement[0]).toContain(`${TASK_SYMBOLS.due} 2026-02-28`);
	});

	test("clamps yearly recurrence on leap day", () => {
		const registry = new StatusRegistry();
		const result = toggleTaskAtLine({
			lines: [
				`- [ ] Parent ${TASK_SYMBOLS.due} 2024-02-29 ${TASK_SYMBOLS.recurrence} every 2 years`,
			],
			lineNumber: 0,
			metadata: null,
			registry,
			settings,
		});

		expect(result?.replacement[0]).toContain(`${TASK_SYMBOLS.due} 2026-02-28`);
	});

	test("exposes recurring toggles through the core API", () => {
		const api = createTestCoreApi();

		const result = api.executeTasksToggleCommand(
			`- [ ] Parent ${TASK_SYMBOLS.due} 2026-05-20 ${TASK_SYMBOLS.recurrence} every week`,
			"tasks.md",
		);

		const lines: string[] = result.split("\n");
		expect(lines).toEqual([
			`- [ ] Parent ${TASK_SYMBOLS.due} 2026-05-27 ${TASK_SYMBOLS.recurrence} every week`,
			expect.stringContaining(`- [x] Parent ${TASK_SYMBOLS.due} 2026-05-20`),
		]);
	});

	test("normalizes done dates for single-line core API toggles", () => {
		const api = createTestCoreApi();

		const result = api.executeTasksToggleCommand("- [x] Ship", "tasks.md");

		expect(result).toBe(`- [x] Ship ${TASK_SYMBOLS.done} 2026-05-16`);
	});

	test("copies subtasks for core API toggles when the source file is open", () => {
		const view = {
			file: {path: "tasks.md"},
			editor: {
				getValue: () =>
					[
						`- [ ] Parent ${TASK_SYMBOLS.due} 2026-05-20 ${TASK_SYMBOLS.recurrence} every week`,
						`  - [x] Child done ${TASK_SYMBOLS.done} 2026-05-19 ${TASK_SYMBOLS.id} abc`,
						"  - plain note",
					].join("\n"),
			},
		};
		const api = createTestCoreApi({workspace: {activeEditor: view, getLeavesOfType: () => []}});

		const result = api.executeTasksToggleCommand(
			`- [ ] Parent ${TASK_SYMBOLS.due} 2026-05-20 ${TASK_SYMBOLS.recurrence} every week`,
			"tasks.md",
		);

		expect(result.split("\n")).toEqual([
			`- [ ] Parent ${TASK_SYMBOLS.due} 2026-05-27 ${TASK_SYMBOLS.recurrence} every week`,
			"  - [ ] Child done",
			"  - plain note",
			expect.stringContaining(`- [x] Parent ${TASK_SYMBOLS.due} 2026-05-20`),
			expect.stringContaining("  - [x] Child done"),
			"  - plain note",
		]);
	});

	test("uses open file context when core API passes an already-checked child line", () => {
		const view = {
			file: {path: "tasks.md"},
			editor: {
				getValue: () =>
					[
						"- [ ] Parent",
						"  - [x] First child",
						"  - [ ] Second child",
					].join("\n"),
			},
		};
		const api = createTestCoreApi({workspace: {activeEditor: view, getLeavesOfType: () => []}});

		const result = api.executeTasksToggleCommand("- [x] Second child", "tasks.md");

		expect(result.split("\n")).toEqual([
			expect.stringContaining(`- [x] Parent ${TASK_SYMBOLS.done} 2026-05-16`),
			"  - [x] First child",
			expect.stringContaining(`  - [x] Second child ${TASK_SYMBOLS.done} 2026-05-16`),
		]);
	});

	test("finishes a task through the native core API without exposing toggle", async () => {
		const registry = new StatusRegistry();
		let content = ["- [ ] Parent", "  - [x] First child", "  - [ ] Second child"].join("\n");
		const file = {path: "tasks.md", basename: "tasks", extension: "md"};
		const app = {
			vault: {
				getAbstractFileByPath: () => file,
				read: () => Promise.resolve(content),
				modify: (_file: unknown, value: string) => {
					content = value;
					return Promise.resolve();
				},
			},
			metadataCache: {
				getFileCache: () => null,
			},
		};
		const api = createTaskLiteCoreApi({
			app: app as TaskLitePlugin["app"],
			registry,
			getSettings: () => settings,
		});

		expect("toggleTask" in api).toBe(false);
		expect(await api.updateTaskStatus("tasks.md", 2, "x")).toBe(true);
		expect(content.split("\n")).toEqual([
			expect.stringContaining(`- [x] Parent ${TASK_SYMBOLS.done} 2026-05-16`),
			"  - [x] First child",
			expect.stringContaining(`  - [x] Second child ${TASK_SYMBOLS.done} 2026-05-16`),
		]);
	});

	test("cancels a task through the native core API and cancels satisfied parents", async () => {
		const registry = new StatusRegistry();
		let content = ["- [ ] Parent", "  - [x] First child", "  - [ ] Second child"].join("\n");
		const file = {path: "tasks.md", basename: "tasks", extension: "md"};
		const app = {
			vault: {
				getAbstractFileByPath: () => file,
				read: () => Promise.resolve(content),
				modify: (_file: unknown, value: string) => {
					content = value;
					return Promise.resolve();
				},
			},
			metadataCache: {
				getFileCache: () => null,
			},
		};
		const api = createTaskLiteCoreApi({
			app: app as TaskLitePlugin["app"],
			registry,
			getSettings: () => settings,
		});

		expect(await api.updateTaskStatus("tasks.md", 2, "-")).toBe(true);
		expect(content.split("\n")).toEqual([
			expect.stringContaining(`- [x] Parent ${TASK_SYMBOLS.done} 2026-05-16`),
			"  - [x] First child",
			expect.stringContaining(`  - [-] Second child ${TASK_SYMBOLS.cancelled} 2026-05-16`),
		]);
	});

	test("cancels unfinished descendants and creates next occurrence for recurring tasks", async () => {
		const registry = new StatusRegistry();
		let content = [
			`- [ ] Parent ${TASK_SYMBOLS.due} 2026-05-20 ${TASK_SYMBOLS.recurrence} every week`,
			"  - [x] Done child",
			"  - [ ] Todo child",
			"    - [ ] Nested todo",
		].join("\n");
		const file = {path: "tasks.md", basename: "tasks", extension: "md"};
		const app = {
			vault: {
				getAbstractFileByPath: () => file,
				read: () => Promise.resolve(content),
				modify: (_file: unknown, value: string) => {
					content = value;
					return Promise.resolve();
				},
			},
			metadataCache: {
				getFileCache: () => null,
			},
		};
		const api = createTaskLiteCoreApi({
			app: app as TaskLitePlugin["app"],
			registry,
			getSettings: () => settings,
		});

		expect(await api.updateTaskStatus("tasks.md", 0, "-")).toBe(true);
		expect(content.split("\n")).toEqual([
			`- [ ] Parent ${TASK_SYMBOLS.due} 2026-05-27 ${TASK_SYMBOLS.recurrence} every week`,
			"  - [ ] Done child",
			"  - [ ] Todo child",
			"    - [ ] Nested todo",
			expect.stringContaining(`- [-] Parent ${TASK_SYMBOLS.due} 2026-05-20 ${TASK_SYMBOLS.cancelled} 2026-05-16`),
			"  - [x] Done child",
			expect.stringContaining(`  - [-] Todo child ${TASK_SYMBOLS.cancelled} 2026-05-16`),
			expect.stringContaining(`    - [-] Nested todo ${TASK_SYMBOLS.cancelled} 2026-05-16`),
		]);
	});

	test("auto-completes parent when all task children are done", () => {
		const registry = new StatusRegistry();
		const result = toggleTaskAtLine({
			lines: [
				"- [ ] Parent",
				"  - [x] First child",
				"  - [ ] Second child",
			],
			lineNumber: 2,
			metadata: null,
			registry,
			settings,
		});

		expect(result?.fromLine).toBe(0);
		expect(result?.toLine).toBe(2);
		expect(result?.replacement).toEqual([
			expect.stringContaining(`- [x] Parent ${TASK_SYMBOLS.done} 2026-05-16`),
			"  - [x] First child",
			expect.stringContaining(`  - [x] Second child ${TASK_SYMBOLS.done} 2026-05-16`),
		]);
	});

	test("editor checkbox click uses finish semantics for unfinished tasks", () => {
		const registry = new StatusRegistry();
		const result = clickTaskCheckboxAtLine({
			lines: [
				"- [ ] Parent",
				"  - [x] First child",
				"  - [ ] Second child",
			],
			lineNumber: 2,
			metadata: null,
			registry,
			settings,
		});

		expect(result?.replacement).toEqual([
			expect.stringContaining(`- [x] Parent ${TASK_SYMBOLS.done} 2026-05-16`),
			"  - [x] First child",
			expect.stringContaining(`  - [x] Second child ${TASK_SYMBOLS.done} 2026-05-16`),
		]);
	});

	test("editor checkbox right click on cancelled child moves to in-progress and unfinishes parent", () => {
		const registry = new StatusRegistry();
		const result = rightClickTaskCheckboxAtLine({
			lines: [
				`- [-] Parent ${TASK_SYMBOLS.cancelled} 2026-05-16`,
				`  - [-] Child ${TASK_SYMBOLS.cancelled} 2026-05-16`,
			],
			lineNumber: 1,
			metadata: null,
			registry,
			settings,
		});

		expect(result?.replacement).toEqual([
			"- [ ] Parent",
			"  - [/] Child",
		]);
	});

	test("right click moves cancelled task to in-progress", () => {
		const registry = new StatusRegistry();
		const result = rightClickTaskCheckboxAtLine({
			lines: [`- [-] Cancelled task ${TASK_SYMBOLS.cancelled} 2026-05-16`],
			lineNumber: 0,
			metadata: null,
			registry,
			settings,
		});

		expect(result?.replacement).toEqual(["- [/] Cancelled task"]);
	});

	test("right click moves done task to todo", () => {
		const registry = new StatusRegistry();
		const result = rightClickTaskCheckboxAtLine({
			lines: [`- [x] Done task ${TASK_SYMBOLS.done} 2026-05-16`],
			lineNumber: 0,
			metadata: null,
			registry,
			settings,
		});

		expect(result?.replacement).toEqual(["- [ ] Done task"]);
	});

	test("unfinish parent only changes parent when cascade is off", () => {
		const registry = new StatusRegistry();
		const result = toggleTaskAtLine({
			lines: [
				`- [x] Parent ${TASK_SYMBOLS.done} 2026-05-16`,
				`  - [x] Child done ${TASK_SYMBOLS.done} 2026-05-16`,
				`  - [-] Child cancelled ${TASK_SYMBOLS.cancelled} 2026-05-16`,
			],
			lineNumber: 0,
			metadata: null,
			registry,
			settings,
		});

		expect(result?.replacement).toEqual([
			"- [ ] Parent",
			`  - [x] Child done ${TASK_SYMBOLS.done} 2026-05-16`,
			`  - [-] Child cancelled ${TASK_SYMBOLS.cancelled} 2026-05-16`,
		]);
	});

	test("unfinish child causes parent to auto-unfinish without cascading to siblings", () => {
		const registry = new StatusRegistry();
		const result = toggleTaskAtLine({
			lines: [
				`- [x] Parent ${TASK_SYMBOLS.done} 2026-05-16`,
				`  - [x] First child ${TASK_SYMBOLS.done} 2026-05-16`,
				`  - [x] Second child ${TASK_SYMBOLS.done} 2026-05-16`,
			],
			lineNumber: 1,
			metadata: null,
			registry,
			settings,
		});

		expect(result?.replacement).toEqual([
			"- [ ] Parent",
			"  - [ ] First child",
		]);
	});

	test("uncancel parent with only cancelled children restores all to todo", () => {
		const registry = new StatusRegistry();
		const result = toggleTaskAtLine({
			lines: [
				`- [-] Parent ${TASK_SYMBOLS.cancelled} 2026-05-16`,
				`  - [-] Child ${TASK_SYMBOLS.cancelled} 2026-05-16`,
			],
			lineNumber: 0,
			metadata: null,
			registry,
			settings,
		});

		expect(result?.replacement).toEqual([
			"- [ ] Parent",
			"  - [ ] Child",
		]);
	});

	test("uncancel parent preserves done children but restores cancelled children", () => {
		const registry = new StatusRegistry();
		const result = toggleTaskAtLine({
			lines: [
				`- [-] Parent ${TASK_SYMBOLS.cancelled} 2026-05-16`,
				`  - [x] Done child ${TASK_SYMBOLS.done} 2026-05-15`,
				`  - [-] Cancelled child ${TASK_SYMBOLS.cancelled} 2026-05-16`,
			],
			lineNumber: 0,
			metadata: null,
			registry,
			settings,
		});

		expect(result?.replacement).toEqual([
			"- [ ] Parent",
			`  - [x] Done child ${TASK_SYMBOLS.done} 2026-05-15`,
			"  - [ ] Cancelled child",
		]);
	});

	test("cascade finish off: only target task changes", () => {
		const registry = new StatusRegistry();
		const noCascadeSettings = {...settings, toggleBehavior: {...settings.toggleBehavior, cascadeFinish: false}};
		const result = toggleTaskAtLine({
			lines: [
				"- [ ] Parent",
				"  - [ ] Child",
			],
			lineNumber: 0,
			metadata: null,
			registry,
			settings: noCascadeSettings,
		});

		expect(result?.replacement).toEqual([
			expect.stringContaining(`- [x] Parent ${TASK_SYMBOLS.done}`),
			"  - [ ] Child",
		]);
	});

	test("cascade cancel off: only target task changes", () => {
		const registry = new StatusRegistry();
		const noCascadeSettings = {...settings, toggleBehavior: {...settings.toggleBehavior, cascadeCancel: false}};
		const result = cancelTaskAtLine({
			lines: [
				"- [ ] Parent",
				"  - [ ] Child",
			],
			lineNumber: 0,
			metadata: null,
			registry,
			settings: noCascadeSettings,
		});

		expect(result?.replacement).toEqual([
			expect.stringContaining(`- [-] Parent ${TASK_SYMBOLS.cancelled}`),
			"  - [ ] Child",
		]);
	});

	test("parentOnCancel off: cancel does not auto-done parent", () => {
		const registry = new StatusRegistry();
		const noParentSettings = {...settings, toggleBehavior: {...settings.toggleBehavior, parentOnCancel: false}};
		const result = cancelTaskAtLine({
			lines: [
				"- [ ] Parent",
				`  - [x] Done child ${TASK_SYMBOLS.done} 2026-05-16`,
				"  - [ ] Todo child",
			],
			lineNumber: 2,
			metadata: null,
			registry,
			settings: noParentSettings,
		});

		expect(result?.replacement).toEqual([
			expect.stringContaining(`  - [-] Todo child ${TASK_SYMBOLS.cancelled}`),
		]);
	});

	test("parentOnCancel: cancel last remaining child auto-dones parent", () => {
		const registry = new StatusRegistry();
		const result = cancelTaskAtLine({
			lines: [
				"- [ ] Parent",
				"  - [ ] Only child",
			],
			lineNumber: 1,
			metadata: null,
			registry,
			settings,
		});

		expect(result?.replacement).toEqual([
			expect.stringContaining(`- [x] Parent ${TASK_SYMBOLS.done}`),
			expect.stringContaining(`  - [-] Only child ${TASK_SYMBOLS.cancelled}`),
		]);
	});

	test("parentOnUnfinish off: unfinish child does not change parent", () => {
		const registry = new StatusRegistry();
		const noParentSettings = {...settings, toggleBehavior: {...settings.toggleBehavior, parentOnUnfinish: false}};
		const result = unfinishTaskAtLine({
			lines: [
				`- [x] Parent ${TASK_SYMBOLS.done} 2026-05-16`,
				`  - [x] Child ${TASK_SYMBOLS.done} 2026-05-16`,
			],
			lineNumber: 1,
			metadata: null,
			registry,
			settings: noParentSettings,
		});

		expect(result?.replacement).toEqual([
			"  - [ ] Child",
		]);
	});

	test("creates next occurrence when a recurring ancestor is auto-completed", () => {
		const registry = new StatusRegistry();
		const result = toggleTaskAtLine({
			lines: [
				`- [ ] Daily workout ${TASK_SYMBOLS.due} 2026-05-22 ${TASK_SYMBOLS.recurrence} every day`,
				"  - [x] Cardio",
				"  - [ ] Curl",
				"    - [x] Curl G.1",
				"    - [x] Curl G.2",
				"    - [ ] Curl G.3",
			],
			lineNumber: 5,
			metadata: null,
			registry,
			settings,
		});

		expect(result?.fromLine).toBe(0);
		expect(result?.toLine).toBe(5);
		expect(result?.replacement).toEqual([
			`- [ ] Daily workout ${TASK_SYMBOLS.due} 2026-05-23 ${TASK_SYMBOLS.recurrence} every day`,
			"  - [ ] Cardio",
			"  - [ ] Curl",
			"    - [ ] Curl G.1",
			"    - [ ] Curl G.2",
			"    - [ ] Curl G.3",
			expect.stringContaining(`- [x] Daily workout ${TASK_SYMBOLS.due} 2026-05-22 ${TASK_SYMBOLS.done} 2026-05-16`),
			"  - [x] Cardio",
			expect.stringContaining(`  - [x] Curl ${TASK_SYMBOLS.done} 2026-05-16`),
			"    - [x] Curl G.1",
			"    - [x] Curl G.2",
			expect.stringContaining(`    - [x] Curl G.3 ${TASK_SYMBOLS.done} 2026-05-16`),
		]);
	});

	test("parses onCompletion field in task metadata", () => {
		const registry = new StatusRegistry();
		const task = parseTaskLine(
			`- [ ] Ship ${TASK_SYMBOLS.due} 2026-05-20 ${TASK_SYMBOLS.recurrence} every week ${TASK_SYMBOLS.onCompletion} delete`,
			registry.get(" "),
		);

		expect(task?.data.recurrence).toBe("every week");
		expect(task?.data.onCompletion).toBe("delete");
	});

	test("deletes completed recurring task when onCompletion is delete", () => {
		const registry = new StatusRegistry();
		const result = toggleTaskAtLine({
			lines: [
				`- [ ] Ship ${TASK_SYMBOLS.due} 2026-05-20 ${TASK_SYMBOLS.recurrence} every week ${TASK_SYMBOLS.onCompletion} delete`,
			],
			lineNumber: 0,
			metadata: null,
			registry,
			settings,
		});

		expect(result?.replacement).toEqual([
			`- [ ] Ship ${TASK_SYMBOLS.due} 2026-05-27 ${TASK_SYMBOLS.recurrence} every week ${TASK_SYMBOLS.onCompletion} delete`,
		]);
		expect(result?.fromLine).toBe(0);
		expect(result?.toLine).toBe(0);
	});

	test("deletes completed recurring parent with subtasks when onCompletion is delete", () => {
		const registry = new StatusRegistry();
		const result = toggleTaskAtLine({
			lines: [
				`- [ ] Parent ${TASK_SYMBOLS.due} 2026-05-20 ${TASK_SYMBOLS.recurrence} every week ${TASK_SYMBOLS.onCompletion} delete`,
				`  - [x] Child done ${TASK_SYMBOLS.done} 2026-05-19 ${TASK_SYMBOLS.id} abc`,
				"  - plain note",
				"- [ ] Sibling",
			],
			lineNumber: 0,
			metadata: null,
			registry,
			settings,
		});

		expect(result?.fromLine).toBe(0);
		expect(result?.toLine).toBe(2);
		expect(result?.replacement).toEqual([
			`- [ ] Parent ${TASK_SYMBOLS.due} 2026-05-27 ${TASK_SYMBOLS.recurrence} every week ${TASK_SYMBOLS.onCompletion} delete`,
			"  - [ ] Child done",
			"  - plain note",
		]);
	});

	test("keeps completed recurring task when onCompletion is keep", () => {
		const registry = new StatusRegistry();
		const result = toggleTaskAtLine({
			lines: [
				`- [ ] Ship ${TASK_SYMBOLS.due} 2026-05-20 ${TASK_SYMBOLS.recurrence} every week ${TASK_SYMBOLS.onCompletion} keep`,
			],
			lineNumber: 0,
			metadata: null,
			registry,
			settings,
		});

		expect(result?.replacement).toEqual([
			`- [ ] Ship ${TASK_SYMBOLS.due} 2026-05-27 ${TASK_SYMBOLS.recurrence} every week ${TASK_SYMBOLS.onCompletion} keep`,
			expect.stringContaining(`- [x] Ship ${TASK_SYMBOLS.due} 2026-05-20`),
		]);
	});

	test("deletes old recurring task when completing new occurrence with onCompletion delete", () => {
		const registry = new StatusRegistry();
		const result = toggleTaskAtLine({
			lines: [
				`- [ ] Ship ${TASK_SYMBOLS.due} 2026-05-27 ${TASK_SYMBOLS.recurrence} every week ${TASK_SYMBOLS.onCompletion} delete`,
			],
			lineNumber: 0,
			metadata: null,
			registry,
			settings,
		});

		expect(result?.fromLine).toBe(0);
		expect(result?.toLine).toBe(0);
		expect(result?.replacement).toEqual([
			`- [ ] Ship ${TASK_SYMBOLS.due} 2026-06-03 ${TASK_SYMBOLS.recurrence} every week ${TASK_SYMBOLS.onCompletion} delete`,
		]);
	});

	test("deletes non-recurring task when onCompletion is delete", () => {
		const registry = new StatusRegistry();
		const result = toggleTaskAtLine({
			lines: [`- [ ] test delete ${TASK_SYMBOLS.scheduled} 2026-05-30 ${TASK_SYMBOLS.onCompletion} delete`],
			lineNumber: 0,
			metadata: null,
			registry,
			settings,
		});

		expect(result?.fromLine).toBe(0);
		expect(result?.toLine).toBe(0);
		expect(result?.replacement).toEqual([]);
	});

	test("deletes non-recurring task with subtasks when onCompletion is delete", () => {
		const registry = new StatusRegistry();
		const result = toggleTaskAtLine({
			lines: [
				`- [ ] Parent ${TASK_SYMBOLS.onCompletion} delete`,
				"  - [ ] Child",
				"- [ ] Sibling",
			],
			lineNumber: 0,
			metadata: null,
			registry,
			settings,
		});

		expect(result?.fromLine).toBe(0);
		expect(result?.toLine).toBe(1);
		expect(result?.replacement).toEqual([]);
	});

	test("full lifecycle: complete → delete → complete again with delete", () => {
		const registry = new StatusRegistry();

		const lines1 = [`- [ ] Task ${TASK_SYMBOLS.due} 2026-05-20 ${TASK_SYMBOLS.recurrence} every week ${TASK_SYMBOLS.onCompletion} delete`];
		const r1 = toggleTaskAtLine({lines: lines1, lineNumber: 0, metadata: null, registry, settings});
		expect(r1?.replacement.length).toBe(1);
		expect(r1?.replacement[0]).toContain("2026-05-27");

		const lines2 = [...r1!.replacement];
		const r2 = toggleTaskAtLine({lines: lines2, lineNumber: 0, metadata: null, registry, settings});
		expect(r2?.replacement.length).toBe(1);
		expect(r2?.replacement[0]).toContain("2026-06-03");
	});

	test("does not duplicate an already-created recurring occurrence", () => {
		const registry = new StatusRegistry();
		const result = toggleTaskAtLine({
			lines: [
				`- [ ] Daily workout ${TASK_SYMBOLS.due} 2026-05-23 ${TASK_SYMBOLS.recurrence} every day`,
				"  - [ ] Cardio",
				"  - [ ] Curl",
				"    - [ ] Curl G.1",
				"    - [ ] Curl G.2",
				"    - [ ] Curl G.3",
				`- [ ] Daily workout ${TASK_SYMBOLS.due} 2026-05-22 ${TASK_SYMBOLS.recurrence} every day`,
				"  - [x] Cardio",
				"  - [ ] Curl",
				"    - [x] Curl G.1",
				"    - [x] Curl G.2",
				"    - [ ] Curl G.3",
			],
			lineNumber: 11,
			metadata: null,
			registry,
			settings,
		});

		expect(result?.fromLine).toBe(6);
		expect(result?.replacement).toEqual([
			expect.stringContaining(`- [x] Daily workout ${TASK_SYMBOLS.due} 2026-05-22 ${TASK_SYMBOLS.done} 2026-05-16`),
			"  - [x] Cardio",
			expect.stringContaining(`  - [x] Curl ${TASK_SYMBOLS.done} 2026-05-16`),
			"    - [x] Curl G.1",
			"    - [x] Curl G.2",
			expect.stringContaining(`    - [x] Curl G.3 ${TASK_SYMBOLS.done} 2026-05-16`),
		]);
	});

	test("reconciles external checkbox-only completion with parent and recurrence rules", () => {
		const registry = new StatusRegistry();
		const before = [
			`- [ ] Daily workout ${TASK_SYMBOLS.due} 2026-05-22 ${TASK_SYMBOLS.recurrence} every day`,
			"  - [x] Cardio",
			"  - [ ] Curl",
			"    - [x] Curl G.1",
			"    - [x] Curl G.2",
			"    - [ ] Curl G.3",
		];
		const after = [
			`- [ ] Daily workout ${TASK_SYMBOLS.due} 2026-05-22 ${TASK_SYMBOLS.recurrence} every day`,
			"  - [x] Cardio",
			"  - [ ] Curl",
			"    - [x] Curl G.1",
			"    - [x] Curl G.2",
			"    - [x] Curl G.3",
		];

		const result = reconcileExternalTaskCompletion({before, after, registry, settings});

		expect(result?.split("\n")).toEqual([
			`- [ ] Daily workout ${TASK_SYMBOLS.due} 2026-05-23 ${TASK_SYMBOLS.recurrence} every day`,
			"  - [ ] Cardio",
			"  - [ ] Curl",
			"    - [ ] Curl G.1",
			"    - [ ] Curl G.2",
			"    - [ ] Curl G.3",
			expect.stringContaining(`- [x] Daily workout ${TASK_SYMBOLS.due} 2026-05-22 ${TASK_SYMBOLS.done} 2026-05-16`),
			"  - [x] Cardio",
			expect.stringContaining(`  - [x] Curl ${TASK_SYMBOLS.done} 2026-05-16`),
			"    - [x] Curl G.1",
			"    - [x] Curl G.2",
			expect.stringContaining(`    - [x] Curl G.3 ${TASK_SYMBOLS.done} 2026-05-16`),
		]);
	});

	test("does not reconcile external edits that change line count", () => {
		const registry = new StatusRegistry();
		const result = reconcileExternalTaskCompletion({
			before: ["- [ ] Parent", "  - [ ] Child"],
			after: ["- [ ] Parent"],
			registry,
			settings,
		});

		expect(result).toBeNull();
	});

	test("caches task records and rebuilds only invalidated files", async () => {
		const registry = new StatusRegistry();
		let firstContent = "- [ ] First";
		let secondContent = "- [ ] Second";
		let readCount = 0;
		const events = new Map<string, (file: unknown, oldPath?: string) => void>();
		const firstFile = createTestFile("first.md", "first");
		const secondFile = createTestFile("second.md", "second");
		const app = {
			vault: {
				on: (name: string, callback: (file: unknown, oldPath?: string) => void) => {
					events.set(name, callback);
					return {};
				},
				getMarkdownFiles: () => [firstFile, secondFile],
				cachedRead: (file: {path: string}) => {
					readCount++;
					return Promise.resolve(file.path === "first.md" ? firstContent : secondContent);
				},
				getAbstractFileByPath: (path: string) => (path === "first.md" ? firstFile : secondFile),
			},
			metadataCache: {
				getFileCache: () => null,
				on: (name: string, callback: (file: unknown) => void) => {
					events.set(name, callback);
					return {};
				},
			},
		};
		const plugin = {
			registerEvent: () => {},
		};
		const store = new TaskDocumentStore(app as TaskLitePlugin["app"], registry);
		store.register(plugin as unknown as TaskLitePlugin);

		expect(await store.listRecords()).toHaveLength(2);
		expect(await store.listRecords()).toHaveLength(2);
		expect(readCount).toBe(2);

		firstContent = "- [ ] First changed";
		store.invalidate("first.md");
		expect(await store.listRecords()).toHaveLength(2);
		expect(readCount).toBe(3);

		secondContent = "- [ ] Second changed";
		events.get("changed")?.(secondFile);
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(await store.listRecords()).toHaveLength(2);
		expect(readCount).toBe(4);
	});


	test("document store forgetFolder invalidates all child files within folder and triggers domain event", async () => {
		const registry = new StatusRegistry();
		const events = new Map<string, (file: unknown, oldPath?: string) => void>();
		const triggeredEvents: Array<{ name: string; data: unknown }> = [];
		const file1 = createTestFile("projects/projectA/task1.md", "task1");
		const file2 = createTestFile("projects/projectA/task2.md", "task2");
		const file3 = createTestFile("other/task3.md", "task3");
		let readCount = 0;
		const app = {
			vault: {
				on: (name: string, callback: (file: unknown, oldPath?: string) => void) => {
					events.set(name, callback);
					return {};
				},
				getMarkdownFiles: () => [file1, file2, file3],
				cachedRead: () => {
					readCount++;
					return Promise.resolve("- [ ] Task");
				},
				getAbstractFileByPath: (path: string) => {
					if (path === "projects/projectA/task1.md") return file1;
					if (path === "projects/projectA/task2.md") return file2;
					return file3;
				},
			},
			metadataCache: {
				getFileCache: () => null,
				on: (name: string, callback: (file: unknown) => void) => {
					events.set(name, callback);
					return {};
				},
			},
			workspace: {
				trigger: (name: string, data: unknown) => {
					triggeredEvents.push({ name, data });
				},
			},
		};
		const store = new TaskDocumentStore(app as unknown as TaskLitePlugin["app"], registry);
		store.register({ registerEvent: () => {} } as unknown as TaskLitePlugin);

		await store.listRecords();
		expect(readCount).toBe(3);

		// Folder delete event
		const folderToDelete = {
			path: "projects/projectA",
			children: [file1, file2],
		};
		events.get("delete")?.(folderToDelete);

		expect(store.getCachedDocument("projects/projectA/task1.md")).toBeNull();
		expect(store.getCachedDocument("projects/projectA/task2.md")).toBeNull();
		expect(store.getCachedDocument("other/task3.md")).not.toBeNull();
		expect(triggeredEvents.some((e) => e.name === "tasklite:tasks-changed" && (e.data as any).path === "projects/projectA")).toBe(true);
	});

	test("document store skips reading files that metadataCache knows have no tasks", async () => {
		const registry = new StatusRegistry();
		const nonTaskFile = createTestFile("article.md", "article");
		const taskFile = createTestFile("todo.md", "todo");
		let readCount = 0;
		const app = {
			vault: {
				on: () => {},
				getMarkdownFiles: () => [nonTaskFile, taskFile],
				cachedRead: (file: {path: string}) => {
					readCount++;
					return Promise.resolve(file.path === "todo.md" ? "- [ ] Active task" : "# Just an article\nNo tasks here");
				},
				getAbstractFileByPath: (path: string) => (path === "todo.md" ? taskFile : nonTaskFile),
			},
			metadataCache: {
				getFileCache: (file: {path: string}) => {
					if (file.path === "article.md") {
						return {
							listItems: [{ position: { start: { line: 1, col: 0, offset: 0 }, end: { line: 1, col: 5, offset: 5 } }, parent: -1 }],
						};
					}
					if (file.path === "todo.md") {
						return {
							listItems: [{ position: { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 15, offset: 15 } }, task: " ", parent: -1 }],
						};
					}
					return null;
				},
				on: () => ({}),
			},
			workspace: {
				layoutReady: true,
				onLayoutReady: (cb: () => void) => cb(),
			},
		};
		const store = new TaskDocumentStore(app as any, registry);
		const records = await store.listRecords();
		expect(records).toHaveLength(1);
		expect(records[0]?.task.description).toBe("Active task");
		// Crucial assertion: article.md was NEVER read from vault because metadata indicated no tasks!
		expect(readCount).toBe(1);
	});

	test("document store correctly links root body tasks to frontmatter tasks with parentLine: -1", async () => {
		const registry = new StatusRegistry();
		const fmFile = createTestFile("fm.md", "fm");
		const app = {
			vault: {
				on: () => {},
				getMarkdownFiles: () => [fmFile],
				cachedRead: () => Promise.resolve([
					"---",
					"task: true",
					"description: Project Alpha",
					"---",
					"- [ ] Line-level task",
				].join("\n")),
			},
			metadataCache: {
				getFileCache: () => ({
					frontmatter: {
						task: true,
						description: "Project Alpha",
					},
				}),
				on: () => {},
			},
		};
		const plugin = {
			registerEvent: () => {},
		};
		const store = new TaskDocumentStore(app as TaskLitePlugin["app"], registry);
		store.register(plugin as unknown as TaskLitePlugin);

		const records = await store.listRecords();
		expect(records).toHaveLength(2);

		const fmRecord = records.find(r => r.lineNumber === -1);
		const lineRecord = records.find(r => r.lineNumber === 4);

		expect(fmRecord).toBeDefined();
		expect(lineRecord).toBeDefined();

		expect(lineRecord?.parentLine).toBe(-1);
		expect(lineRecord?.depth).toBe(0);
	});

	test("document store skips non-task list item ancestors to link to nearest task or frontmatter task", async () => {
		const registry = new StatusRegistry();
		const fmFile = createTestFile("fm.md", "fm");
		const app = {
			vault: {
				on: () => {},
				getMarkdownFiles: () => [fmFile],
				cachedRead: () => Promise.resolve([
					"---",
					"task: true",
					"description: Project Alpha",
					"---",
					"- Plain text list parent",
					"    - [ ] Child task nested under plain text list parent",
				].join("\n")),
			},
			metadataCache: {
				getFileCache: () => ({
					frontmatter: {
						task: true,
						description: "Project Alpha",
					},
				}),
				on: () => {},
			},
		};
		const plugin = {
			registerEvent: () => {},
		};
		const store = new TaskDocumentStore(app as TaskLitePlugin["app"], registry);
		store.register(plugin as unknown as TaskLitePlugin);

		const records = await store.listRecords();
		expect(records).toHaveLength(2); // Frontmatter task and Child task

		const fmRecord = records.find(r => r.lineNumber === -1);
		const lineRecord = records.find(r => r.lineNumber === 5);

		expect(fmRecord).toBeDefined();
		expect(lineRecord).toBeDefined();

		// Since its immediate parent (line 4) is plain text (not a task), it should skip it
		// and link to the frontmatter task (line -1) because there is no other ancestor task.
		expect(lineRecord?.parentLine).toBe(-1);
	});

	describe("bracket edge cases", () => {
		test("empty brackets are not treated as a checkbox", () => {
			const registry = new StatusRegistry();
			const tree = buildTaskTree(["- [] - []"], null, registry);
			const node = tree.byLine.get(0);
			expect(node).toBeDefined();
			expect(node!.task).toBeNull();
			expect(node!.statusCharacter).toBeNull();
		});

		test("standalone -[] without space is not a checkbox", () => {
			const registry = new StatusRegistry();
			const tree = buildTaskTree(["-[]"], null, registry);
			const node = tree.byLine.get(0);
			expect(node).toBeDefined();
			expect(node!.statusCharacter).toBeNull();
			expect(node!.task).toBeNull();
		});

		test("- [x] is a valid done task", () => {
			const registry = new StatusRegistry();
			const tree = buildTaskTree(["- [x]"], null, registry);
			const node = tree.byLine.get(0);
			expect(node).toBeDefined();
			expect(node!.statusCharacter).toBe("x");
			expect(node!.task).not.toBeNull();
			expect(node!.task!.data.status).toBe("DONE");
		});

		test("- [-] is a valid cancelled task", () => {
			const registry = new StatusRegistry();
			const tree = buildTaskTree(["- [-] task"], null, registry);
			const node = tree.nodes[0];
			expect(node).not.toBeNull();
			expect(node!.task).not.toBeNull();
			expect(node!.task!.data.status).toBe("CANCELLED");
		});

		test("- [/] is a valid in-progress task", () => {
			const registry = new StatusRegistry();
			const tree = buildTaskTree(["- [/] task"], null, registry);
			const node = tree.nodes[0];
			expect(node).not.toBeNull();
			expect(node!.task).not.toBeNull();
			expect(node!.task!.data.status).toBe("IN_PROGRESS");
		});

		test("- [ ] -[] toggles the first checkbox, not the -[]", () => {
			const registry = new StatusRegistry();
			const result = toggleTaskAtLine({
				lines: ["- [ ] -[]"],
				lineNumber: 0,
				metadata: null,
				registry,
				settings,
			});

			expect(result).not.toBeNull();
			expect(result?.replacement[0]).toContain("- [x] -[]");
			expect(result?.replacement[0]).toContain(TASK_SYMBOLS.done);
		});

		test("- [ ] [] in description is treated as text", () => {
			const registry = new StatusRegistry();
			const tree = buildTaskTree(["- [ ] []"], null, registry);
			const node = tree.byLine.get(0);
			expect(node).toBeDefined();
			expect(node!.task).not.toBeNull();
			expect(node!.task!.data.status).toBe("TODO");
			expect(node!.task!.data.description).toBe("[]");
		});

		test("- [ ] [x] in description is treated as text", () => {
			const registry = new StatusRegistry();
			const tree = buildTaskTree(["- [ ] [x]"], null, registry);
			const node = tree.nodes[0];
			expect(node).not.toBeNull();
			expect(node!.task).not.toBeNull();
			expect(node!.task!.data.description).toBe("[x]");
		});

		test("multiple -[] in description are treated as text", () => {
			const registry = new StatusRegistry();
			const tree = buildTaskTree(["- [ ] -[] -[]"], null, registry);
			const node = tree.nodes[0];
			expect(node).not.toBeNull();
			expect(node!.task).not.toBeNull();
			expect(node!.task!.data.description).toBe("-[] -[]");
		});

		test("same-line metadata from bare - in a task description is ignored", () => {
			expectSameLineMetadataIsIgnored("    - [ ] -", "-");
		});

		test("same-line metadata from - [] in a task description is ignored", () => {
			expectSameLineMetadataIsIgnored("    - [ ] - []", "- []");
		});

		test("- [] no trailing text is a list item without task", () => {
			const registry = new StatusRegistry();
			const tree = buildTaskTree(["- []"], null, registry);
			const node = tree.byLine.get(0);
			expect(node).toBeDefined();
			expect(node!.statusCharacter).toBeNull();
			expect(node!.task).toBeNull();
		});

		test("- [] followed by text is a list item without task", () => {
			const registry = new StatusRegistry();
			const tree = buildTaskTree(["- [] hello"], null, registry);
			const node = tree.byLine.get(0);
			expect(node).toBeDefined();
			expect(node!.statusCharacter).toBeNull();
			expect(node!.task).toBeNull();
		});
	});

	describe("regex boundary cases", () => {
		test("* marker works as list marker", () => {
			const registry = new StatusRegistry();
			const tree = buildTaskTree(["* [ ] task"], null, registry);
			const node = tree.byLine.get(0);
			expect(node).toBeDefined();
			expect(node!.task).not.toBeNull();
			expect(node!.listMarker).toBe("*");
		});

		test("+ marker works as list marker", () => {
			const registry = new StatusRegistry();
			const tree = buildTaskTree(["+ [ ] task"], null, registry);
			const node = tree.byLine.get(0);
			expect(node).toBeDefined();
			expect(node!.task).not.toBeNull();
			expect(node!.listMarker).toBe("+");
		});

		test("tab indentation is recognized", () => {
			const registry = new StatusRegistry();
			const tree = buildTaskTree(["\t- [ ] task"], null, registry);
			const node = tree.byLine.get(0);
			expect(node).toBeDefined();
			expect(node!.task).not.toBeNull();
			expect(node!.indentation).toBe("\t");
		});

		test("space indentation is recognized", () => {
			const registry = new StatusRegistry();
			const tree = buildTaskTree(["  - [ ] task"], null, registry);
			const node = tree.byLine.get(0);
			expect(node).toBeDefined();
			expect(node!.task).not.toBeNull();
			expect(node!.indentation).toBe("  ");
		});

		test("blockquote prefix is recognized", () => {
			const registry = new StatusRegistry();
			const tree = buildTaskTree(["> - [ ] task"], null, registry);
			const node = tree.byLine.get(0);
			expect(node).toBeDefined();
			expect(node!.task).not.toBeNull();
			expect(node!.indentation).toBe("> ");
		});

		test("numbered list marker is recognized", () => {
			const registry = new StatusRegistry();
			const tree = buildTaskTree(["1) [ ] task"], null, registry);
			const node = tree.byLine.get(0);
			expect(node).toBeDefined();
			expect(node!.task).not.toBeNull();
			expect(node!.listMarker).toBe("1)");
		});

		test("numbered list marker with dot is recognized", () => {
			const registry = new StatusRegistry();
			const tree = buildTaskTree(["1. [ ] task"], null, registry);
			const node = tree.byLine.get(0);
			expect(node).toBeDefined();
			expect(node!.task).not.toBeNull();
			expect(node!.listMarker).toBe("1.");
		});

		test("non-list line is not matched", () => {
			const registry = new StatusRegistry();
			const tree = buildTaskTree(["just text"], null, registry);
			expect(tree.nodes.length).toBe(0);
		});

		test("empty line is not matched", () => {
			const registry = new StatusRegistry();
			const tree = buildTaskTree([""], null, registry);
			expect(tree.nodes.length).toBe(0);
		});

		test("list item without checkbox has null statusCharacter", () => {
			const registry = new StatusRegistry();
			const tree = buildTaskTree(["- plain item"], null, registry);
			const node = tree.byLine.get(0);
			expect(node).toBeDefined();
			expect(node!.statusCharacter).toBeNull();
			expect(node!.task).toBeNull();
			expect(node!.description).toBe("plain item");
		});
	});

	describe("toggle edge cases", () => {
		test("toggling a done task unfinishes it", () => {
			const registry = new StatusRegistry();
			const result = toggleTaskAtLine({
				lines: [`- [x] done task ${TASK_SYMBOLS.done} 2026-05-16`],
				lineNumber: 0,
				metadata: null,
				registry,
				settings,
			});

			expect(result).not.toBeNull();
			expect(result?.replacement[0]).toBe("- [ ] done task");
		});

		test("toggling a cancelled task uncancels it", () => {
			const registry = new StatusRegistry();
			const result = toggleTaskAtLine({
				lines: [`- [-] cancelled ${TASK_SYMBOLS.cancelled} 2026-05-16`],
				lineNumber: 0,
				metadata: null,
				registry,
				settings,
			});

			expect(result).not.toBeNull();
			expect(result?.replacement[0]).toBe("- [ ] cancelled");
		});

		test("clicking an in-progress task cancels it in forward cycle", () => {
			const registry = new StatusRegistry();
			const result = clickTaskCheckboxAtLine({
				lines: ["- [/] in progress"],
				lineNumber: 0,
				metadata: null,
				registry,
				settings,
			});

			expect(result).not.toBeNull();
			expect(result?.replacement[0]).toContain("- [-] in progress");
		});

		test("right-clicking an in-progress task marks it done in reverse cycle", () => {
			const registry = new StatusRegistry();
			const result = rightClickTaskCheckboxAtLine({
				lines: ["- [/] in progress"],
				lineNumber: 0,
				metadata: null,
				registry,
				settings,
			});

			expect(result).not.toBeNull();
			expect(result?.replacement[0]).toContain("- [x] in progress");
		});

		test("right-clicking a todo task cancels it", () => {
			const registry = new StatusRegistry();
			const result = rightClickTaskCheckboxAtLine({
				lines: ["- [ ] todo"],
				lineNumber: 0,
				metadata: null,
				registry,
				settings,
			});

			expect(result).not.toBeNull();
			expect(result?.replacement[0]).toContain("- [-] todo");
		});

		test("full forward cycle: todo -> done -> in-progress -> cancelled -> todo", () => {
			const registry = new StatusRegistry();
			let lines = ["- [ ] Cycling task"];

			// 1. todo -> done
			let res = clickTaskCheckboxAtLine({lines, lineNumber: 0, metadata: null, registry, settings});
			expect(res?.replacement[0]).toContain("- [x] Cycling task");
			lines = res!.replacement;

			// 2. done -> in-progress
			res = clickTaskCheckboxAtLine({lines, lineNumber: 0, metadata: null, registry, settings});
			expect(res?.replacement[0]).toContain("- [/] Cycling task");
			lines = res!.replacement;

			// 3. in-progress -> cancelled
			res = clickTaskCheckboxAtLine({lines, lineNumber: 0, metadata: null, registry, settings});
			expect(res?.replacement[0]).toContain("- [-] Cycling task");
			lines = res!.replacement;

			// 4. cancelled -> todo
			res = clickTaskCheckboxAtLine({lines, lineNumber: 0, metadata: null, registry, settings});
			expect(res?.replacement[0]).toContain("- [ ] Cycling task");
		});

		test("full reverse cycle: todo -> cancelled -> in-progress -> done -> todo", () => {
			const registry = new StatusRegistry();
			let lines = ["- [ ] Cycling task"];

			// 1. todo -> cancelled
			let res = rightClickTaskCheckboxAtLine({lines, lineNumber: 0, metadata: null, registry, settings});
			expect(res?.replacement[0]).toContain("- [-] Cycling task");
			lines = res!.replacement;

			// 2. cancelled -> in-progress
			res = rightClickTaskCheckboxAtLine({lines, lineNumber: 0, metadata: null, registry, settings});
			expect(res?.replacement[0]).toContain("- [/] Cycling task");
			lines = res!.replacement;

			// 3. in-progress -> done
			res = rightClickTaskCheckboxAtLine({lines, lineNumber: 0, metadata: null, registry, settings});
			expect(res?.replacement[0]).toContain("- [x] Cycling task");
			lines = res!.replacement;

			// 4. done -> todo
			res = rightClickTaskCheckboxAtLine({lines, lineNumber: 0, metadata: null, registry, settings});
			expect(res?.replacement[0]).toContain("- [ ] Cycling task");
		});

		test("toggling non-existent line returns null", () => {
			const registry = new StatusRegistry();
			const result = toggleTaskAtLine({
				lines: ["- [ ] task"],
				lineNumber: 5,
				metadata: null,
				registry,
				settings,
			});

			expect(result).toBeNull();
		});

		test("toggling plain text line returns null", () => {
			const registry = new StatusRegistry();
			const result = toggleTaskAtLine({
				lines: ["just text"],
				lineNumber: 0,
				metadata: null,
				registry,
				settings,
			});

			expect(result).toBeNull();
		});

		test("toggling empty file returns null", () => {
			const registry = new StatusRegistry();
			const result = toggleTaskAtLine({
				lines: [],
				lineNumber: 0,
				metadata: null,
				registry,
				settings,
			});

			expect(result).toBeNull();
		});
	});

	describe("parseTaskBody edge cases", () => {
		test("empty body produces empty description", () => {
			const task = parseTaskLine("- [ ] ", "TODO");
			expect(task).not.toBeNull();
			expect(task!.data.description).toBe("");
		});

		test("body with only spaces produces empty description", () => {
			const task = parseTaskLine("- [ ]   ", "TODO");
			expect(task).not.toBeNull();
			expect(task!.data.description).toBe("");
		});

		test("priority emoji is extracted from description", () => {
			const task = parseTaskLine("- [ ] task 🔺", "TODO");
			expect(task).not.toBeNull();
			expect(task!.data.description).toBe("task");
			expect(task!.data.priority).toBe("highest");
		});

		test("lowest priority emoji is extracted", () => {
			const task = parseTaskLine("- [ ] task ⏬", "TODO");
			expect(task).not.toBeNull();
			expect(task!.data.priority).toBe("lowest");
		});

		test("multiple dates are all extracted", () => {
			const task = parseTaskLine("- [ ] task 🛫 2026-01-01 📅 2026-12-31", "TODO");
			expect(task).not.toBeNull();
			expect(task!.data.dates.start).toBe("2026-01-01");
			expect(task!.data.dates.due).toBe("2026-12-31");
			expect(task!.data.description).toBe("task");
		});

		test("block link is extracted", () => {
			const task = parseTaskLine("- [ ] task ^block-id", "TODO");
			expect(task).not.toBeNull();
			expect(task!.data.blockLink).toBe("^block-id");
			expect(task!.data.description).toBe("task");
		});

		test("tags are extracted from description", () => {
			const task = parseTaskLine("- [ ] task #work #urgent", "TODO");
			expect(task).not.toBeNull();
			expect(task!.data.tags).toEqual(["#work", "#urgent"]);
		});

		test("unicode emoji in description is preserved", () => {
			const task = parseTaskLine("- [ ] 买菜 🛒", "TODO");
			expect(task).not.toBeNull();
			expect(task!.data.description).toBe("买菜 🛒");
		});

		test("remind date and times in dates are parsed correctly", () => {
			const task = parseTaskLine("- [ ] task ⏰ 2026-06-05 18:40 📅 2026-06-05 6:40 PM", "TODO");
			expect(task).not.toBeNull();
			expect(task!.data.dates.remind).toBe("2026-06-05 18:40");
			expect(task!.data.dates.due).toBe("2026-06-05 6:40 PM");
			expect(task!.data.description).toBe("task");
		});
	});

	describe("tree parent-child edge cases", () => {
		test("indented child is linked to parent", () => {
			const registry = new StatusRegistry();
			const tree = buildTaskTree(["- [ ] parent", "  - [ ] child"], null, registry);
			expect(tree.nodes.length).toBe(2);
			expect(tree.nodes[1]!.parent).toBe(tree.nodes[0]);
			expect(tree.nodes[0]!.children).toContain(tree.nodes[1]);
		});

		test("deeply nested children form correct chain", () => {
			const registry = new StatusRegistry();
			const tree = buildTaskTree(
				["- [ ] level0", "  - [ ] level1", "    - [ ] level2"],
				null,
				registry,
			);
			expect(tree.nodes.length).toBe(3);
			expect(tree.nodes[2]!.parent).toBe(tree.nodes[1]);
			expect(tree.nodes[1]!.parent).toBe(tree.nodes[0]);
			expect(tree.nodes[0]!.parent).toBeNull();
		});

		test("mixed tasks and plain items in tree", () => {
			const registry = new StatusRegistry();
			const tree = buildTaskTree(
				["- [ ] task", "- plain note", "- [ ] another task"],
				null,
				registry,
			);
			expect(tree.nodes.length).toBe(3);
			expect(tree.nodes[0]!.task).not.toBeNull();
			expect(tree.nodes[1]!.task).toBeNull();
			expect(tree.nodes[2]!.task).not.toBeNull();
		});

		test("child plain item under task parent", () => {
			const registry = new StatusRegistry();
			const tree = buildTaskTree(
				["- [ ] parent", "  - plain child"],
				null,
				registry,
			);
			expect(tree.nodes.length).toBe(2);
			expect(tree.nodes[0]!.task).not.toBeNull();
			expect(tree.nodes[1]!.task).toBeNull();
			expect(tree.nodes[1]!.parent).toBe(tree.nodes[0]);
		});

		test("child indented by two levels is linked to parent", () => {
			const registry = new StatusRegistry();
			const tree = buildTaskTree(["- [ ] parent", "    - [ ] child skipped level"], null, registry);
			expect(tree.nodes.length).toBe(2);
			expect(tree.nodes[1]!.parent).toBe(tree.nodes[0]);
		});
	});

	describe("reconciliation edge cases", () => {
		test("external completion of task adds done date", () => {
			const registry = new StatusRegistry();
			const result = reconcileExternalTaskCompletion({
				before: ["- [ ] task"],
				after: ["- [x] task"],
				registry,
				settings,
			});

			expect(result).not.toBeNull();
			expect(result).toContain(`- [x] task ${TASK_SYMBOLS.done}`);
		});

		test("external edit with same content returns null", () => {
			const registry = new StatusRegistry();
			const result = reconcileExternalTaskCompletion({
				before: ["- [ ] task"],
				after: ["- [ ] task"],
				registry,
				settings,
			});

			expect(result).toBeNull();
		});

		test("external edit changing line count returns null", () => {
			const registry = new StatusRegistry();
			const result = reconcileExternalTaskCompletion({
				before: ["- [ ] task"],
				after: ["- [ ] task", "extra line"],
				registry,
				settings,
			});

			expect(result).toBeNull();
		});

		test("external completion of already-done task returns null", () => {
			const registry = new StatusRegistry();
			const result = reconcileExternalTaskCompletion({
				before: [`- [x] task ${TASK_SYMBOLS.done} 2026-05-16`],
				after: [`- [x] task ${TASK_SYMBOLS.done} 2026-05-16`],
				registry,
				settings,
			});

			expect(result).toBeNull();
		});

		test("external description change is not treated as completion", () => {
			const registry = new StatusRegistry();
			const result = reconcileExternalTaskCompletion({
				before: ["- [ ] old description"],
				after: ["- [ ] new description"],
				registry,
				settings,
			});

			expect(result).toBeNull();
		});

		test("external completion with -[] in description", () => {
			const registry = new StatusRegistry();
			const result = reconcileExternalTaskCompletion({
				before: ["- [ ] task -[]"],
				after: ["- [x] task -[]"],
				registry,
				settings,
			});

			expect(result).not.toBeNull();
			expect(result).toContain(`- [x] task -[] ${TASK_SYMBOLS.done}`);
		});
	});

	describe("task identity edge cases", () => {
		test("tasks with same description but different done dates match", () => {
			const task1 = parseTaskLine("- [ ] task ✅ 2026-01-01", "TODO");
			const task2 = parseTaskLine("- [x] task ✅ 2026-01-02", "DONE");
			expect(taskIdentityKey(task1!.data)).toBe(taskIdentityKey(task2!.data));
		});

		test("tasks with different descriptions don't match", () => {
			const task1 = parseTaskLine("- [ ] task1", "TODO");
			const task2 = parseTaskLine("- [ ] task2", "TODO");
			expect(taskIdentityKey(task1!.data)).not.toBe(taskIdentityKey(task2!.data));
		});

		test("tasks with -[] in description match across states", () => {
			const task1 = parseTaskLine("- [ ] task -[]", "TODO");
			const task2 = parseTaskLine("- [x] task -[]", "DONE");
			expect(taskIdentityKey(task1!.data)).toBe(taskIdentityKey(task2!.data));
		});
	});

	describe("task query filters", () => {
		test("filters common DQL-like task fields", () => {
			const records = createQueryRecords();

			expect(filterTaskRecordsByQuery(records, 'status = "TODO"').map((record) => record.task.description)).toEqual([
				"Ship dashboard",
				"Backlog item",
			]);
			expect(filterTaskRecordsByQuery(records, "due <= date(today)").map((record) => record.task.description)).toEqual([
				"Ship dashboard",
			]);
			expect(filterTaskRecordsByQuery(records, "scheduled <= date(today)").map((record) => record.task.description)).toEqual([
				"Ship dashboard",
			]);
			expect(filterTaskRecordsByQuery(records, 'priority = ""').map((record) => record.task.description)).toEqual([
				"Backlog item",
			]);
			expect(filterTaskRecordsByQuery(records, 'priority = "highest"').map((record) => record.task.description)).toEqual([
				"Ship dashboard",
			]);
			expect(filterTaskRecordsByQuery(records, 'priority = "🔺"').map((record) => record.task.description)).toEqual([
				"Ship dashboard",
			]);
			expect(filterTaskRecordsByQuery(records, 'priority > "medium"').map((record) => record.task.description)).toEqual([
				"Ship dashboard",
			]);
			expect(filterTaskRecordsByQuery(records, 'path =~ "Work/"').map((record) => record.task.description)).toEqual([
				"Ship dashboard",
				"Backlog item",
				"Done report",
			]);
			expect(filterTaskRecordsByQuery(records, 'tags contains "#work"').map((record) => record.task.description)).toEqual([
				"Ship dashboard",
			]);
			expect(filterTaskRecordsByQuery(records, 'assignee = "Alice"').map((record) => record.task.description)).toEqual([
				"Ship dashboard",
			]);
			expect(filterTaskRecordsByQuery(records, "hasChildren = true").map((record) => record.task.description)).toEqual([
				"Ship dashboard",
			]);
			expect(filterTaskRecordsByQuery(records, "parentLine = null").map((record) => record.task.description)).toEqual([
				"Ship dashboard",
				"Done report",
			]);
			expect(filterTaskRecordsByQuery(records, 'description contains "Backlog"').map((record) => record.task.description)).toEqual([
				"Backlog item",
			]);
		});

		test("supports AND OR NOT and parentheses", () => {
			const records = createQueryRecords();
			const result = filterTaskRecordsByQuery(
				records,
				'(status = "TODO" AND path =~ "Work/") OR (NOT hasChildren = true AND tags contains "#later")',
			);

			expect(result.map((record) => record.task.description)).toEqual([
				"Ship dashboard",
				"Backlog item",
			]);
		});

		test("filters through the core API", async () => {
			const api = createTestCoreApi({
				vault: {
					getMarkdownFiles: () => [createTestFile("Work/tasks.md", "tasks")],
					cachedRead: () => [
						`- [ ] Ship dashboard ${TASK_SYMBOLS.due} 2026-05-16 #work`,
						"  - [ ] Child task",
						"- [x] Done report",
					].join("\n"),
				},
				metadataCache: {
					getFileCache: () => null,
				},
			});

			const listed = await api.listTasks({
				includeChildren: true,
				includeCompleted: true,
				query: 'status = "TODO" AND tags contains "#work"',
			});
			const all = await api.listTasks({includeChildren: true, includeCompleted: true});
			const filtered = api.filterTasks(all, 'description contains "Child"');

			expect(listed.map((record) => record.task.description)).toEqual(["Ship dashboard #work"]);
			expect(filtered.map((record) => record.task.description)).toEqual(["Child task"]);
		});

		test("supports multi-person assignment query using &", () => {
			const records = [
				createQueryRecord({
					path: "Work/tasks.md",
					lineNumber: 0,
					parentLine: null,
					description: "Task A",
					status: "TODO",
					assignee: "Alice & Bob",
				}),
				createQueryRecord({
					path: "Work/tasks.md",
					lineNumber: 1,
					parentLine: null,
					description: "Task B",
					status: "TODO",
					assignee: "Alice",
				}),
				createQueryRecord({
					path: "Work/tasks.md",
					lineNumber: 2,
					parentLine: null,
					description: "Task C",
					status: "TODO",
					assignee: "Charlie",
				}),
			];

			expect(filterTaskRecordsByQuery(records, 'assignee = "Alice"').map((record) => record.task.description)).toEqual([
				"Task A",
				"Task B",
			]);
			// Verify that "person" query works as an alias
			expect(filterTaskRecordsByQuery(records, 'person = "Bob"').map((record) => record.task.description)).toEqual([
				"Task A",
			]);
			expect(filterTaskRecordsByQuery(records, 'assignee = "Charlie"').map((record) => record.task.description)).toEqual([
				"Task C",
			]);
			expect(filterTaskRecordsByQuery(records, 'assignee != "Alice"').map((record) => record.task.description)).toEqual([
				"Task C",
			]);
		});

		test("supports relative dates in date(...) function", () => {
			const records = createQueryRecords();
			// today in fakeMoment is 2026-05-16
			// Ship dashboard: due = 2026-05-16, scheduled = 2026-05-15
			// Backlog item: due = 2026-05-20, scheduled = 2026-05-20
			expect(filterTaskRecordsByQuery(records, "scheduled = date(yesterday)").map((r) => r.task.description)).toEqual([
				"Ship dashboard",
			]);
			expect(filterTaskRecordsByQuery(records, "due < date(tomorrow)").map((r) => r.task.description)).toEqual([
				"Ship dashboard",
			]);
			expect(filterTaskRecordsByQuery(records, "due = date(today, +4d)").map((r) => r.task.description)).toEqual([
				"Backlog item",
				"Done report",
			]);
			expect(filterTaskRecordsByQuery(records, "due = date(today + 4d)").map((r) => r.task.description)).toEqual([
				"Backlog item",
				"Done report",
			]);
			expect(filterTaskRecordsByQuery(records, "due <= date(next-week)").map((r) => r.task.description)).toEqual([
				"Ship dashboard",
				"Backlog item",
				"Done report",
			]);
			expect(filterTaskRecordsByQuery(records, "due = date(+4d)").map((r) => r.task.description)).toEqual([
				"Backlog item",
				"Done report",
			]);
			expect(filterTaskRecordsByQuery(records, "due = date('2026-05-20')").map((r) => r.task.description)).toEqual([
				"Backlog item",
				"Done report",
			]);
		});

		test("supports task domain macros happens(...) and is(...)", () => {
			const records = [
				...createQueryRecords(),
				createQueryRecord({
					path: "Work/overdue.md",
					lineNumber: 0,
					parentLine: null,
					description: "Overdue task",
					status: "TODO",
					due: "2026-05-10",
				}),
				createQueryRecord({
					path: "Work/cancelled.md",
					lineNumber: 0,
					parentLine: null,
					description: "Cancelled task",
					status: "CANCELLED",
					due: "2026-05-10",
				}),
				createQueryRecord({
					path: "Work/spanning.md",
					lineNumber: 0,
					parentLine: null,
					description: "Spanning project",
					status: "TODO",
					start: "2026-05-10",
					due: "2026-05-20",
				}),
				createQueryRecord({
					path: "Work/openended.md",
					lineNumber: 0,
					parentLine: null,
					description: "Open-ended project",
					status: "TODO",
					start: "2026-05-10",
				}),
			];

			// is(open)
			expect(filterTaskRecordsByQuery(records, "is(open)").map((r) => r.task.description)).toEqual([
				"Ship dashboard",
				"Backlog item",
				"Overdue task",
				"Spanning project",
				"Open-ended project",
			]);

			// is(done)
			expect(filterTaskRecordsByQuery(records, "is(done)").map((r) => r.task.description)).toEqual([
				"Done report",
			]);

			// is(cancelled)
			expect(filterTaskRecordsByQuery(records, "is(cancelled)").map((r) => r.task.description)).toEqual([
				"Cancelled task",
			]);

			// is(overdue) - strictly due < today (2026-05-16)
			expect(filterTaskRecordsByQuery(records, "is(overdue)").map((r) => r.task.description)).toEqual([
				"Overdue task",
			]);

			// is(overdate) - strictly scheduled < today (2026-05-16)
			// Ship dashboard has scheduled: "2026-05-15" (yesterday), due: "2026-05-16" (today)
			expect(filterTaskRecordsByQuery(records, "is(overdate)").map((r) => r.task.description)).toEqual([
				"Ship dashboard",
			]);

			// covers(today) and cover(date)
			expect(filterTaskRecordsByQuery(records, "covers(today)").map((r) => r.task.description)).toEqual([
				"Spanning project",
				"Open-ended project",
			]);
			expect(filterTaskRecordsByQuery(records, 'covers("2026-05-20")').map((r) => r.task.description)).toEqual([
				"Spanning project",
				"Open-ended project",
			]);
			expect(filterTaskRecordsByQuery(records, 'covers("2026-05-21")').map((r) => r.task.description)).toEqual([
				"Open-ended project",
			]);
			expect(filterTaskRecordsByQuery(records, 'covers("2026-05-09")').map((r) => r.task.description)).toEqual([]);

			// is(root) vs is(subtask)
			expect(filterTaskRecordsByQuery(records, "is(root)").map((r) => r.task.description)).toEqual([
				"Ship dashboard",
				"Done report",
				"Overdue task",
				"Cancelled task",
				"Spanning project",
				"Open-ended project",
			]);
			expect(filterTaskRecordsByQuery(records, "is(subtask)").map((r) => r.task.description)).toEqual([
				"Backlog item",
			]);

			// happens(today)
			expect(filterTaskRecordsByQuery(records, "happens(today)").map((r) => r.task.description)).toEqual([
				"Ship dashboard",
			]);

			// happens("2026-05-20")
			expect(filterTaskRecordsByQuery(records, 'happens("2026-05-20")').map((r) => r.task.description)).toEqual([
				"Backlog item",
				"Done report",
				"Spanning project",
			]);

			// Combined GTD column query: is(open) AND (happens(today) OR covers(today) OR is(overdue) OR is(overdate))
			expect(
				filterTaskRecordsByQuery(records, "is(open) AND (happens(today) OR covers(today) OR is(overdue) OR is(overdate))").map(
					(r) => r.task.description,
				),
			).toEqual([
				"Ship dashboard",
				"Overdue task",
				"Spanning project",
				"Open-ended project",
			]);
		});
	});

	test("listTasks includes both line-level tasks and file-level tasks", async () => {
		const api = createTestCoreApi({
			vault: {
				getMarkdownFiles: () => [createTestFile("Work/tasks.md", "tasks")],
				cachedRead: () => [
					"---",
					"task: true",
					"description: Project Alpha",
					"status: \" \"",
					"---",
					"- [ ] Line-level task",
				].join("\n"),
			},
			metadataCache: {
				getFileCache: () => ({
					frontmatter: {
						task: true,
						description: "Project Alpha",
						status: " ",
					},
				}),
			},
		});

		const listed = await api.listTasks({ includeChildren: true });
		expect(listed.map((record) => record.task.description)).toEqual([
			"Project Alpha",
			"Line-level task",
		]);
	});

	test("frontmatter task supports status keywords and preserves them on update", async () => {
		let fmState: Record<string, unknown> = {
			task: true,
			status: "todo",
			description: "Project Keyword",
		};
		const file = createTestFile("Work/project.md", "project");
		const api = createTestCoreApi({
			vault: {
				getMarkdownFiles: () => [file],
				cachedRead: () => [
					"---",
					"task: true",
					"status: todo",
					"description: Project Keyword",
					"---",
				].join("\n"),
				read: () => Promise.resolve([
					"---",
					"task: true",
					"status: todo",
					"description: Project Keyword",
					"---",
				].join("\n")),
				getAbstractFileByPath: () => file,
			},
			fileManager: {
				// Simulate Obsidian's processFrontMatter: pass fm to callback, persist result
				processFrontMatter: (_f: unknown, fn: (fm: Record<string, unknown>) => void) => {
					fn(fmState);
					return Promise.resolve();
				},
			},
			metadataCache: {
				getFileCache: () => ({
					frontmatter: { ...fmState },
				}),
			},
		});

		const listed = await api.listTasks();
		expect(listed).toHaveLength(1);
		expect(listed[0]?.task.status).toBe("TODO");

		// Toggle it to DONE — processFrontMatter should update fmState.status
		const result = await api.updateTaskStatus("Work/project.md", -1, "x");
		expect(result).toBe(true);
		expect(fmState.status).toBe("done");

		// Toggle it back to TODO
		const result2 = await api.updateTaskStatus("Work/project.md", -1, " ");
		expect(result2).toBe(true);
		expect(fmState.status).toBe("todo");
	});

	test("createTask can create a frontmatter task", async () => {
		const fmState: Record<string, unknown> = {};
		const file = createTestFile("Work/new-project.md", "new-project");
		const api = createTestCoreApi({
			vault: {
				getAbstractFileByPath: () => null,
				create: (path: string, content: string) => {
					expect(path).toBe("Work/new-project.md");
					return Promise.resolve(file);
				},
			},
			fileManager: {
				processFrontMatter: (_f: unknown, fn: (fm: Record<string, unknown>) => void) => {
					fn(fmState);
					return Promise.resolve();
				},
			},
		});

		await api.createTask({
			description: "New Project Task",
			status: "/",
			priority: "high",
			dates: {
				due: "2026-06-30",
				scheduled: "2026-06-29 10:00",
			},
			path: "Work/new-project.md",
			isFileTask: true,
		});

		expect(fmState.task).toBe(true);
		expect(fmState.description).toBe("New Project Task");
		expect(fmState.status).toBe("/");
		expect(fmState.priority).toBe("high");
		expect(fmState.due).toBe("2026-06-30");
		expect(fmState.scheduled).toBe("2026-06-29 10:00");
	});

	test("createTask throws error when isFileTask is true and parentLineNumber is set", async () => {
		const api = createTestCoreApi({});
		await expect(
			api.createTask({
				description: "Invalid Task",
				path: "Work/new-project.md",
				isFileTask: true,
				parentLineNumber: 5,
			})
		).rejects.toThrow("file-level tasks cannot have a parentLineNumber");
	});

	test("createTask inserts new child task at the bottom of the parent's subtree", async () => {
		let fileContent = [
			"- [ ] Parent Task",
			"    - [ ] Child 1",
			"    - [ ] Child 2",
			"- [ ] Other Task",
		].join("\n");
		const file = createTestFile("tasks.md", "tasks");
		const api = createTestCoreApi({
			vault: {
				getAbstractFileByPath: () => file,
				read: () => Promise.resolve(fileContent),
				modify: (_f: unknown, content: string) => {
					fileContent = content;
					return Promise.resolve();
				},
			},
			metadataCache: {
				getFileCache: () => null,
			},
		});

		await api.createTask({
			description: "Child 3",
			parentLineNumber: 0,
			path: "tasks.md",
		});

		expect(fileContent.split("\n")).toEqual([
			"- [ ] Parent Task",
			"    - [ ] Child 1",
			"    - [ ] Child 2",
			"\t- [ ] Child 3",
			"- [ ] Other Task",
		]);
	});
});

function createTestCoreApi(app: Record<string, unknown> = {}) {
	const plugin = createTestPlugin(app);
	return plugin.api;
}

function createTestPlugin(app: Record<string, unknown> = {}) {
	const registry = new StatusRegistry();
	const testApp = app as TaskLitePlugin["app"];
	const api = createTaskLiteCoreApi({
		app: testApp,
		registry,
		getSettings: () => settings,
	});
	return {
		app: testApp,
		settings,
		statusRegistry: registry,
		api,
	} as TaskLitePlugin;
}

function createTestFile(path: string, basename: string) {
	return {path, basename, extension: "md"};
}

function createQueryRecords(): TaskDocumentRecord[] {
	return [
		createQueryRecord({
			path: "Work/tasks.md",
			lineNumber: 0,
			parentLine: null,
			hasChildren: true,
			description: "Ship dashboard",
			status: "TODO",
			priority: "highest",
			due: "2026-05-16",
			scheduled: "2026-05-15",
			tags: ["#work"],
			assignee: "Alice",
		}),
		createQueryRecord({
			path: "Work/tasks.md",
			lineNumber: 1,
			parentLine: 0,
			depth: 1,
			description: "Backlog item",
			status: "TODO",
			due: "2026-05-20",
			scheduled: "2026-05-20",
			tags: ["#later"],
		}),
		createQueryRecord({
			path: "Work/done.md",
			lineNumber: 0,
			parentLine: null,
			description: "Done report",
			status: "DONE",
			priority: "medium",
			due: "2026-05-20",
			tags: ["#archive"],
			assignee: "Bob",
		}),
	];
}

function createQueryRecord(input: {
	path: string;
	lineNumber: number;
	parentLine: number | null;
	depth?: number;
	hasChildren?: boolean;
	description: string;
	status: "TODO" | "DONE" | "IN_PROGRESS" | "ON_HOLD" | "CANCELLED" | "NON_TASK" | "EMPTY";
	priority?: TaskPriority | null;
	start?: string | null;
	due?: string | null;
	scheduled?: string | null;
	tags?: string[];
	assignee?: string | string[] | null;
}): TaskDocumentRecord {
	return {
		path: input.path,
		basename: input.path.split("/").pop()?.replace(/\.md$/u, "") ?? input.path,
		lineNumber: input.lineNumber,
		parentLine: input.parentLine,
		depth: input.depth ?? 0,
		hasChildren: input.hasChildren ?? false,
		task: {
			status: input.status,
			description: input.description,
			priority: input.priority ?? null,
			dates: {
				start: input.start ?? null,
				created: null,
				scheduled: input.scheduled ?? null,
				due: input.due ?? null,
				done: null,
				cancelled: null,
				remind: null,
			},
			recurrence: null,
			onCompletion: null,
			dependsOn: null,
			id: null,
			assignee: typeof input.assignee === "string"
				? input.assignee.split("&").map((p) => p.trim()).filter(Boolean)
				: (Array.isArray(input.assignee) ? input.assignee : []),
			blockLink: null,
			tags: input.tags ?? [],
		},
	};
}

function expectSameLineMetadataIsIgnored(lastLine: string, description: string): void {
	const registry = new StatusRegistry();
	const lines = [
		"- [ ] test-father",
		"    - [ ] test",
		lastLine,
	];
	const metadata = {
		listItems: [
			createListItem(0, -1, 0, " "),
			createListItem(1, 0, 4, " "),
			createListItem(2, 1, 4, " "),
			createListItem(2, 2, 12),
		],
	} as CachedMetadata;

	const tree = buildTaskTree(lines, metadata, registry);
	const node = tree.byLine.get(2);

	expect(tree.nodes).toHaveLength(3);
	expect(node).toBeDefined();
	expect(node!.parentLine).toBe(1);
	expect(node!.parent?.lineNumber).toBe(1);
	expect(node!.children).toHaveLength(0);
	expect(node!.task?.data.description).toBe(description);
}

function createListItem(line: number, parent: number, col: number, task?: string): ListItemCache {
	return {
		id: `${line}:${col}`,
		parent,
		task,
		position: {
			start: {line, col, offset: 0},
			end: {line, col, offset: 0},
		},
	} as unknown as ListItemCache;
}

function parseDate(value: string): Date {
	const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
	return new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1));
}

function formatDate(date: Date): string {
	const year = date.getUTCFullYear().toString().padStart(4, "0");
	const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
	const day = date.getUTCDate().toString().padStart(2, "0");
	return `${year}-${month}-${day}`;
}

describe("indentation normalization", () => {
	test("converts spaces to tab when useTab is true", () => {
		expect(normalizeLineIndentation("    - [ ] task", true, 4)).toBe("\t- [ ] task");
		expect(normalizeLineIndentation("      - [ ] task", true, 4)).toBe("\t  - [ ] task");
		expect(normalizeLineIndentation("  - [ ] task", true, 4)).toBe("  - [ ] task");
		expect(normalizeLineIndentation("\t- [ ] task", true, 4)).toBe("\t- [ ] task");
	});

	test("converts tabs to spaces when useTab is false", () => {
		expect(normalizeLineIndentation("\t- [ ] task", false, 4)).toBe("    - [ ] task");
		expect(normalizeLineIndentation("\t  - [ ] task", false, 4)).toBe("      - [ ] task");
		expect(normalizeLineIndentation("  - [ ] task", false, 4)).toBe("  - [ ] task");
	});

	test("preserves quote blocks (>) and only normalizes list item indents", () => {
		expect(normalizeLineIndentation("> - [ ] task", true, 4)).toBe("> - [ ] task");
		expect(normalizeLineIndentation(">   - [ ] task", true, 4)).toBe(">   - [ ] task");
		expect(normalizeLineIndentation(">     - [ ] task", true, 4)).toBe("> \t- [ ] task");
		expect(normalizeLineIndentation("> \t- [ ] task", false, 4)).toBe(">     - [ ] task");
	});

	test("does nothing to non-list lines", () => {
		expect(normalizeLineIndentation("just some text", true, 4)).toBe("just some text");
		expect(normalizeLineIndentation("  just indented text", true, 4)).toBe("  just indented text");
	});
});

describe("TaskLite 0.4.5 Features", () => {
	test("generateSemanticId limits base ID to 8 characters using initials", () => {
		expect(generateSemanticId("feat: support blocking and ID")).toBe("fsbai");
		expect(generateSemanticId("自动生成带语义ID（英语+hyphen，中文拼音）")).toBe("zdscdyyi");
		expect(generateSemanticId("feat: 添加API返回assignee集合")).toBe("ftjafhaj");
		expect(generateSemanticId("")).toHaveLength(8);
	});

	test("generateSemanticId appends date suffix for recurring tasks", () => {
		// With explicit due date
		expect(generateSemanticId("feat: support blocking", {
			isRecurring: true,
			dueDate: "2026-06-13",
		})).toBe("fsb-2026-06-13");

		// Without due date (uses fallback date format YYYY-MM-DD)
		const idWithoutDue = generateSemanticId("feat: support blocking", {
			isRecurring: true,
		});
		expect(idWithoutDue).toMatch(/^fsb-\d{4}-\d{2}-\d{2}$/);
	});

	test("generateSemanticId resolves duplicates in vault using 4-character random suffix", () => {
		const existingIds = new Set(["fsb", "fsb-2026-06-13"]);
		
		// Normal task duplicate
		const normalId = generateSemanticId("feat: support blocking", { existingIds });
		expect(normalId).not.toBe("fsb");
		expect(normalId).toMatch(/^fsb-[a-z0-9]{4}$/);

		// Recurring task duplicate
		const recurringId = generateSemanticId("feat: support blocking", {
			isRecurring: true,
			dueDate: "2026-06-13",
			existingIds,
		});
		expect(recurringId).not.toBe("fsb-2026-06-13");
		expect(recurringId).toMatch(/^fsb-2026-06-13-[a-z0-9]{4}$/);
	});

	test("listAssignees returns sorted unique assignees", async () => {
		const registry = new StatusRegistry();
		const file = createTestFile("tasks.md", "tasks");
		const app = {
			vault: {
				getMarkdownFiles: () => [file],
				cachedRead: () => Promise.resolve([
					"- [ ] Task 1 👤 Alice & Bob",
					"- [ ] Task 2 👤 Bob & Charlie",
					"- [ ] Task 3 👤 Alice",
				].join("\n")),
			},
			metadataCache: {
				getFileCache: () => null,
			},
		};
		const store = new TaskDocumentStore(app as any, registry);
		const testSettings = { ...settings, assignees: [] as string[] };
		store.onRecordUpdated = (_path, records) => {
			const assignees = new Set<string>(testSettings.assignees);
			for (const r of records) {
				if (r.task.assignee) {
					for (const a of r.task.assignee) {
						const trimmed = a.trim();
						if (trimmed) assignees.add(trimmed);
					}
				}
			}
			testSettings.assignees = Array.from(assignees).sort();
		};

		// Pre-populate store which triggers onRecordUpdated
		await store.getDocument(file as any);

		const api = createTaskLiteCoreApi({
			app: app as any,
			registry,
			getSettings: () => testSettings,
			documentStore: store,
		});

		const assignees = await api.listAssignees();
		expect(assignees).toEqual(["Alice", "Bob", "Charlie"]);
	});

	test("unblockDependentTasks completes dependency and unblocks blocking tasks", async () => {
		const { ExternalTaskReconciler } = await import("../src/editor/externalReconcile");
		const registry = new StatusRegistry();
		const file = createTestFile("tasks.md", "tasks");
		let fileContent = [
			"- [ ] Task A 🆔 task-a",
			"- [ ] Task B ⛔ task-a",
		].join("\n");
		let modifyCalled = false;

		const app = {
			vault: {
				getMarkdownFiles: () => [file],
				cachedRead: () => Promise.resolve(fileContent),
				read: () => Promise.resolve(fileContent),
				modify: (f: any, nextContent: string) => {
					fileContent = nextContent;
					modifyCalled = true;
					return Promise.resolve();
				},
				getAbstractFileByPath: () => file,
				on: () => {},
			},
			metadataCache: {
				getFileCache: () => null,
				on: () => {},
			},
			fileManager: {},
		};

		const store = new TaskDocumentStore(app as any, registry);
		// Load document into cache
		await store.getDocument(file as any);

		const reconciler = new ExternalTaskReconciler(
			{ registerEvent: () => {} } as any,
			app as any,
			registry,
			() => settings,
			store
		);
		reconciler.register();

		// Now simulate completing Task A
		const beforeContent = fileContent;
		const afterContent = [
			"- [x] Task A 🆔 task-a ✅ 2026-05-16",
			"- [ ] Task B ⛔ task-a",
		].join("\n");

		// Set cached document content to mock before state
		await store.replaceDocumentContent(file as any, beforeContent);

		// Call reconcile manually to trigger check
		// Since we mocked read, we'll return afterContent
		app.vault.read = () => Promise.resolve(afterContent);
		await (reconciler as any).reconcile(file);
		// Allow async unblockDependentTasks to run
		await new Promise((resolve) => setTimeout(resolve, 10));

		// The reconciler should have unblocked Task B
		expect(modifyCalled).toBe(true);
		expect(fileContent).toContain("- [x] Task A 🆔 task-a ✅ 2026-05-16");
		expect(fileContent).toContain("- [ ] Task B");
		expect(fileContent).not.toContain("⛔ task-a");
	});

	test("blocked task cannot be completed and shows warning or throws error", async () => {
		const registry = new StatusRegistry();
		const file = createTestFile("tasks.md", "tasks");
		let fileContent = [
			"- [ ] Task A 🆔 task-a",
			"- [ ] Task B ⛔ task-a",
		].join("\n");

		const mockDocumentStore = {
			listCachedRecords: () => [
				{
					path: "tasks.md",
					lineNumber: 0,
					task: {
						id: "task-a",
						status: "TODO", // Not finished
						description: "Task A",
					}
				},
				{
					path: "tasks.md",
					lineNumber: 1,
					task: {
						id: null,
						status: "TODO",
						dependsOn: "task-a",
						description: "Task B",
					}
				}
			],
			getDocumentByPath: () => Promise.resolve({
				lines: fileContent.split("\n"),
				content: fileContent,
			}),
		};

		const app = {
			plugins: {
				plugins: {
					"taskslite": {
						documentStore: mockDocumentStore,
					}
				}
			},
			vault: {
				getMarkdownFiles: () => [file],
				read: () => Promise.resolve(fileContent),
				cachedRead: () => Promise.resolve(fileContent),
				getAbstractFileByPath: () => file,
			},
			metadataCache: {
				getFileCache: () => null,
			}
		};

		// 1. Check in toggle logic (clickTaskCheckboxAtLine)
		const result = clickTaskCheckboxAtLine({
			lines: fileContent.split("\n"),
			lineNumber: 1, // Task B
			metadata: null,
			app: app as any,
			registry,
			settings,
		});

		expect(result).not.toBeNull();
		// State should not change
		expect(result?.replacement[0]).toBe("- [ ] Task B ⛔ task-a");
		expect(result?.warning).toContain("Task is blocked by unfinished dependencies: task-a");

		// 2. Check in API (updateTaskStatus)
		const api = createTaskLiteCoreApi({
			app: app as any,
			registry,
			getSettings: () => settings,
			documentStore: mockDocumentStore as any,
		});

		expect(
			api.updateTaskStatus("tasks.md", 1, "x")
		).rejects.toThrow("Task is blocked by unfinished dependencies: task-a");
	});

	test("assignee autocomplete suggestions trigger and filter correctly", async () => {
		const { TaskLiteEmojiSuggest } = await import("../src/suggest/emojiSuggest");
		const mockPlugin = {
			settings: {
				autoSuggestInEditor: true,
				assignees: ["Alice", "Bob", "Charlie"],
			},
			app: {},
		};
		const suggest = new TaskLiteEmojiSuggest(mockPlugin as any);

		// Mock editor and file
		const file = { path: "test.md" };
		const editor = {
			getLine: (lineNum: number) => "- [ ] Task 👤 Alice & Bo",
		};

		// Cursor at the end: "- [ ] Task 👤 Alice & Bo" (length 24)
		const triggerInfo = suggest.onTrigger(
			{ line: 0, ch: 24 },
			editor as any,
			file as any
		);

		expect(triggerInfo).not.toBeNull();
		expect(triggerInfo?.query).toBe("assignee:bo");
		expect(triggerInfo?.start.ch).toBe(22); // starts precisely at "B"

		// Get suggestions for the query
		const context = { query: "assignee:bo" };
		const suggestions = suggest.getSuggestions(context as any);
		expect(suggestions.length).toBe(1);
		expect(suggestions[0].name).toBe("Bob");
	});

	test("date shorthand autocomplete parses M-D and D patterns", async () => {
		const { parseDateShorthand, getDateSuggestions } = await import("../src/suggest/dateShorthand");
		const now = new Date();
		const currentYear = now.getFullYear();
		const currentMonth = (now.getMonth() + 1).toString().padStart(2, "0");

		// Test 6-1
		const resolved6_1 = parseDateShorthand("6-1");
		expect(resolved6_1).toBe(`${currentYear}-06-01`);

		// Test 11
		const resolved11 = parseDateShorthand("11");
		expect(resolved11).toBe(`${currentYear}-${currentMonth}-11`);

		// Test invalid dates
		expect(parseDateShorthand("2-30")).toBeNull();
		expect(parseDateShorthand("13-1")).toBeNull();
		expect(parseDateShorthand("6-32")).toBeNull();
		expect(parseDateShorthand("32")).toBeNull();

		// Test getDateSuggestions results contains the resolved entries
		const suggestions6_1 = getDateSuggestions("6-1");
		expect(suggestions6_1.length).toBeGreaterThan(0);
		expect(suggestions6_1[0].resolved).toBe(`${currentYear}-06-01`);

		// Test that date suggestions for "06-01" do NOT return hints whose resolved dates match but description doesn't
		const suggestions06_01 = getDateSuggestions("06-01");
		expect(suggestions06_01.length).toBe(1);
		expect(suggestions06_01[0].resolved).toBe(`${currentYear}-06-01`);
	});

	describe("TaskLite 0.5.0 Architecture Improvements", () => {
		test("task-cache.json hits skip file reading when mtime matches", async () => {
			const registry = new StatusRegistry();
			const fileA = { ...createTestFile("fileA.md", "fileA"), stat: { mtime: 1000 } };
			const fileB = { ...createTestFile("fileB.md", "fileB"), stat: { mtime: 1000 } };
			let readCount = 0;

			const cacheData: Record<string, string> = {
				".obsidian/plugins/taskslite/task-cache.json": JSON.stringify({
					version: 1,
					files: {
						"fileA.md": {
							mtime: 1000,
							records: [
								{
									path: "fileA.md",
									basename: "fileA",
									lineNumber: 0,
									parentLine: null,
									depth: 0,
									hasChildren: false,
									task: {
										status: "TODO",
										description: "Cached Task A",
										priority: null,
										dates: { start: null, created: null, scheduled: null, due: null, done: null, cancelled: null, remind: null },
										recurrence: null,
										onCompletion: null,
										dependsOn: null,
										id: null,
										assignee: [],
										blockLink: null,
										tags: [],
										unmatched: null,
									},
								},
							],
						},
						"fileB.md": {
							mtime: 1000,
							records: [],
						},
					},
				}),
			};

			const app = {
				vault: {
					on: () => {},
					getMarkdownFiles: () => [fileA, fileB],
					cachedRead: () => {
						readCount++;
						return Promise.resolve("- [ ] Real read");
					},
					getAbstractFileByPath: (p: string) => (p === "fileA.md" ? fileA : fileB),
					adapter: {
						exists: (p: string) => Promise.resolve(p in cacheData),
						read: (p: string) => Promise.resolve(cacheData[p]),
						write: (p: string, content: string) => {
							cacheData[p] = content;
							return Promise.resolve();
						},
						mkdir: () => Promise.resolve(),
					},
				},
				metadataCache: {
					getFileCache: () => null,
					on: () => {},
				},
			};

			const store = new TaskDocumentStore(app as any, registry);
			const records = await store.listRecords();

			expect(readCount).toBe(0);
			expect(records).toHaveLength(1);
			expect(records[0].task.description).toBe("Cached Task A");
		});

		test("task-cache.json incremental reload only rereads modified files", async () => {
			const registry = new StatusRegistry();
			const fileA = { ...createTestFile("fileA.md", "fileA"), stat: { mtime: 1000 } };
			const fileB = { ...createTestFile("fileB.md", "fileB"), stat: { mtime: 2000 } }; // changed from 1000 to 2000
			const readFiles: string[] = [];

			const cacheData: Record<string, string> = {
				".obsidian/plugins/taskslite/task-cache.json": JSON.stringify({
					version: 1,
					files: {
						"fileA.md": {
							mtime: 1000,
							records: [
								{
									path: "fileA.md",
									basename: "fileA",
									lineNumber: 0,
									parentLine: null,
									depth: 0,
									hasChildren: false,
									task: {
										status: "TODO",
										description: "Cached Task A",
										priority: null,
										dates: { start: null, created: null, scheduled: null, due: null, done: null, cancelled: null, remind: null },
										recurrence: null,
										onCompletion: null,
										dependsOn: null,
										id: null,
										assignee: [],
										blockLink: null,
										tags: [],
										unmatched: null,
									},
								},
							],
						},
						"fileB.md": {
							mtime: 1000,
							records: [],
						},
					},
				}),
			};

			const app = {
				vault: {
					on: () => {},
					getMarkdownFiles: () => [fileA, fileB],
					cachedRead: (f: any) => {
						readFiles.push(f.path);
						return Promise.resolve("- [ ] Fresh Task B");
					},
					getAbstractFileByPath: (p: string) => (p === "fileA.md" ? fileA : fileB),
					adapter: {
						exists: (p: string) => Promise.resolve(p in cacheData),
						read: (p: string) => Promise.resolve(cacheData[p]),
						write: (p: string, content: string) => {
							cacheData[p] = content;
							return Promise.resolve();
						},
						mkdir: () => Promise.resolve(),
					},
				},
				metadataCache: {
					getFileCache: () => null,
					on: () => {},
				},
			};

			const store = new TaskDocumentStore(app as any, registry);
			const records = await store.listRecords();

			// Only fileB should have been read from disk
			expect(readFiles).toEqual(["fileB.md"]);
			expect(records).toHaveLength(2);
			const descriptions = records.map((r) => r.task.description).sort();
			expect(descriptions).toEqual(["Cached Task A", "Fresh Task B"]);
		});

		test("corrupted task-cache.json recovers gracefully without error", async () => {
			const registry = new StatusRegistry();
			const file = { ...createTestFile("test.md", "test"), stat: { mtime: 1000 } };
			let readCount = 0;

			const app = {
				vault: {
					on: () => {},
					getMarkdownFiles: () => [file],
					cachedRead: () => {
						readCount++;
						return Promise.resolve("- [ ] Recovered Task");
					},
					getAbstractFileByPath: () => file,
					adapter: {
						exists: () => Promise.resolve(true),
						read: () => Promise.resolve("MALFORMED JSON {{{"),
						write: () => Promise.resolve(),
						mkdir: () => Promise.resolve(),
					},
				},
				metadataCache: {
					getFileCache: () => null,
					on: () => {},
				},
			};

			const store = new TaskDocumentStore(app as any, registry);
			const records = await store.listRecords();

			expect(readCount).toBe(1);
			expect(records).toHaveLength(1);
			expect(records[0].task.description).toBe("Recovered Task");
		});

		test("listAssignees strictly returns only configured team members and ignores unconfigured names in vault", async () => {
			const registry = new StatusRegistry();
			const file = { ...createTestFile("tasks.md", "tasks"), stat: { mtime: 1000 } };
			let content = "- [ ] Fix bug 👤 Mar";

			const app = {
				vault: {
					on: () => {},
					getMarkdownFiles: () => [file],
					cachedRead: () => Promise.resolve(content),
					read: () => Promise.resolve(content),
					modify: (_f: any, val: string) => {
						content = val;
						return Promise.resolve();
					},
					getAbstractFileByPath: () => file,
				},
				metadataCache: {
					getFileCache: () => null,
					on: () => {},
				},
			};

			const store = new TaskDocumentStore(app as any, registry);
			const testSettings = {
				...settings,
				assignees: ["Alice", "Bob"], // Configured team members
			};

			const api = createTaskLiteCoreApi({
				app: app as any,
				registry,
				getSettings: () => testSettings,
				documentStore: store,
			});

			// Only configured team members (Alice, Bob) are returned; unconfigured 'Mar' in vault is ignored
			const assignees = await api.listAssignees();
			expect(assignees).toEqual(["Alice", "Bob"]);
			expect(assignees).not.toContain("Mar");
		});

	
		test("doesQueryExcludeCompleted detects queries that filter out completed tasks", () => {
			expect(doesQueryExcludeCompleted('status != "DONE"')).toBe(true);
			expect(doesQueryExcludeCompleted("status != 'DONE'")).toBe(true);
			expect(doesQueryExcludeCompleted('status = "TODO"')).toBe(true);
			expect(doesQueryExcludeCompleted('status = "IN_PROGRESS"')).toBe(true);
			expect(doesQueryExcludeCompleted('is(todo)')).toBe(true);
			expect(doesQueryExcludeCompleted('NOT (status = "DONE")')).toBe(true);
			expect(doesQueryExcludeCompleted('NOT is(done)')).toBe(true);
			expect(doesQueryExcludeCompleted('priority = "high" AND status != "DONE"')).toBe(true);
			expect(doesQueryExcludeCompleted('status != "DONE" OR status = "TODO"')).toBe(true);
			expect(doesQueryExcludeCompleted('(status = "TODO" OR status = "IN_PROGRESS") AND priority = "high"')).toBe(true);

			// Should return false when completed is NOT excluded
			expect(doesQueryExcludeCompleted('')).toBe(false);
			expect(doesQueryExcludeCompleted('priority = "high"')).toBe(false);
			expect(doesQueryExcludeCompleted('status = "DONE"')).toBe(false);
			expect(doesQueryExcludeCompleted('status != "CANCELLED"')).toBe(false);
			expect(doesQueryExcludeCompleted('status != "DONE" OR priority = "high"')).toBe(false);
		});

	describe("Dual-Mode Task Format (Phase 2)", () => {
			test("parses Dataview inline fields correctly", () => {
				const registry = new StatusRegistry();
				const task = parseTaskLine(
					"- [ ] Ship MVP [due:: 2026-05-20] [priority:: high] [repeat:: every week] [assignee:: Alice & Bob] [dependsOn:: TASK-1] [id:: TASK-2]",
					registry.get(" ")
				);

				expect(task).not.toBeNull();
				expect(task?.data.description).toBe("Ship MVP");
				expect(task?.data.dates.due).toBe("2026-05-20");
				expect(task?.data.priority).toBe("high");
				expect(task?.data.recurrence).toBe("every week");
				expect(task?.data.assignee).toEqual(["Alice", "Bob"]);
				expect(task?.data.dependsOn).toBe("TASK-1");
				expect(task?.data.id).toBe("TASK-2");
			});

			test("parses Dataview emoji-key fields correctly", () => {
				const registry = new StatusRegistry();
				const task = parseTaskLine(
					"- [ ] Design mockups [📅:: 2026-06-01] [🔺:: highest]",
					registry.get(" ")
				);

				expect(task).not.toBeNull();
				expect(task?.data.description).toBe("Design mockups");
				expect(task?.data.dates.due).toBe("2026-06-01");
				expect(task?.data.priority).toBe("highest");
			});

			test("parses mixed Dataview inline fields and Tasks Emoji metadata", () => {
				const registry = new StatusRegistry();
				const task = parseTaskLine(
					"- [ ] Refactor auth module [due:: 2026-05-20] 🔺 🔁 every 2 weeks",
					registry.get(" ")
				);

				expect(task).not.toBeNull();
				expect(task?.data.description).toBe("Refactor auth module");
				expect(task?.data.dates.due).toBe("2026-05-20");
				expect(task?.data.priority).toBe("highest");
				expect(task?.data.recurrence).toBe("every 2 weeks");
			});

			test("serializes task data in dataview format", () => {
				const registry = new StatusRegistry();
				const task = parseTaskLine(
					"- [ ] Write documentation [due:: 2026-05-20] [priority:: high] [assignee:: Alice]",
					registry.get(" ")
				);
				expect(task).not.toBeNull();
				if (!task) return;

				const serialized = serializeTaskLine(task, "", registry, "dataview");
				expect(serialized).toBe("- [ ] Write documentation [priority:: high] [due:: 2026-05-20] [assignee:: Alice]");
			});

			test("serializes task data in emoji format", () => {
				const registry = new StatusRegistry();
				const task = parseTaskLine(
					"- [ ] Write documentation [due:: 2026-05-20] [priority:: high] [assignee:: Alice]",
					registry.get(" ")
				);
				expect(task).not.toBeNull();
				if (!task) return;

				const serialized = serializeTaskLine(task, "", registry, "emoji");
				expect(serialized).toBe(`- [ ] Write documentation ⏫ ${TASK_SYMBOLS.due} 2026-05-20 ${TASK_SYMBOLS.assignee} Alice`);
			});

			test("provides format-aware autocomplete suggestions for dataview and emoji modes", async () => {
				const { getFieldSuggestions } = await import("../src/suggest/emojiSuggest");
				const dvSuggestions = getFieldSuggestions("dataview");
				const emojiSuggestions = getFieldSuggestions("emoji");

				const dvDue = dvSuggestions.find((s) => s.label.startsWith("Due date"));
				expect(dvDue?.insert).toBe("[due:: ");

				const emojiDue = emojiSuggestions.find((s) => s.label.startsWith("Due date"));
				expect(emojiDue?.insert).toBe("📅 ");

				const dvPriority = dvSuggestions.find((s) => s.label.startsWith("High priority"));
				expect(dvPriority?.insert).toBe("[priority:: high] ");

				const emojiPriority = emojiSuggestions.find((s) => s.label.startsWith("High priority"));
				expect(emojiPriority?.insert).toBe("⏫");

				const dvLocation = dvSuggestions.find((s) => s.label.startsWith("Location"));
				expect(dvLocation?.insert).toBe("[location:: ");

				const emojiLocation = emojiSuggestions.find((s) => s.label.startsWith("Location"));
				expect(emojiLocation?.insert).toBe("📍 ");
			});

			test("parses location in emoji format and dataview format", () => {
				const registry = new StatusRegistry();
				const taskEmoji = parseTaskLine(
					"- [ ] Meet client 👤 Sunny 📍 科学家博物馆 📅 2026-10-20",
					registry.get(" ")
				);
				expect(taskEmoji).not.toBeNull();
				expect(taskEmoji?.data.description).toBe("Meet client");
				expect(taskEmoji?.data.assignee).toEqual(["Sunny"]);
				expect(taskEmoji?.data.location).toBe("科学家博物馆");
				expect(taskEmoji?.data.dates.due).toBe("2026-10-20");

				const taskDv = parseTaskLine(
					"- [ ] Server maintenance [location:: 10.1.130.42] [assignee:: Sunny]",
					registry.get(" ")
				);
				expect(taskDv).not.toBeNull();
				expect(taskDv?.data.description).toBe("Server maintenance");
				expect(taskDv?.data.location).toBe("10.1.130.42");
				expect(taskDv?.data.assignee).toEqual(["Sunny"]);
			});

			test("serializes location in dataview and emoji formats", () => {
				const registry = new StatusRegistry();
				const task = parseTaskLine(
					"- [ ] Visit lab 📍 科学家博物馆 👤 Sunny",
					registry.get(" ")
				);
				expect(task).not.toBeNull();
				if (!task) return;

				const serializedEmoji = serializeTaskLine(task, "", registry, "emoji");
				expect(serializedEmoji).toBe("- [ ] Visit lab 👤 Sunny 📍 科学家博物馆");

				const serializedDv = serializeTaskLine(task, "", registry, "dataview");
				expect(serializedDv).toBe("- [ ] Visit lab [assignee:: Sunny] [location:: 科学家博物馆]");
			});

			test("filters tasks by location query", () => {
				const registry = new StatusRegistry();
				const records: TaskDocumentRecord[] = [
					{
						path: "A.md",
						basename: "A",
						lineNumber: 0,
						parentLine: null,
						depth: 0,
						hasChildren: false,
						task: parseTaskLine("- [ ] Task 1 📍 科学家博物馆", registry.get(" "))!.data,
					},
					{
						path: "B.md",
						basename: "B",
						lineNumber: 0,
						parentLine: null,
						depth: 0,
						hasChildren: false,
						task: parseTaskLine("- [ ] Task 2 📍 10.1.130.42", registry.get(" "))!.data,
					},
				];

				const filteredMuseum = filterTaskRecordsByQuery(records, 'location = "科学家博物馆"');
				expect(filteredMuseum).toHaveLength(1);
				expect(filteredMuseum[0].path).toBe("A.md");

				const filteredIp = filterTaskRecordsByQuery(records, 'location = "10.1.130.42"');
				expect(filteredIp).toHaveLength(1);
				expect(filteredIp[0].path).toBe("B.md");
			});

			test("normalizeVaultTaskFormat converts emoji tasks to dataview format across vault", async () => {
				const registry = new StatusRegistry();
				const file = { path: "Projects/Demo.md", basename: "Demo", stat: { mtime: 1000 } };
				let content = [
					"# Project Demo",
					"- [ ] Meeting with Sunny 👤 Sunny 📍 科学家博物馆 📅 2026-10-20 ⏫",
					"- [/] In progress task 🛫 2026-10-18",
					"- [x] Done task ✅ 2026-10-19",
					"Some notes here",
				].join("\n");

				let modifiedContent = "";
				const app = {
					vault: {
						getMarkdownFiles: () => [file],
						read: () => Promise.resolve(content),
						modify: (_f: any, val: string) => {
							modifiedContent = val;
							content = val;
							return Promise.resolve();
						},
					},
					metadataCache: {
						getFileCache: () => null,
					},
				};

				let replacedContent = "";
				const plugin = {
					statusRegistry: registry,
					documentStore: {
						replaceDocumentContent: (_f: any, val: string) => {
							replacedContent = val;
							return Promise.resolve();
						},
					},
				};

				const result = await normalizeVaultTaskFormat(app as any, plugin as any, "dataview");
				expect(result.totalUpdatedFiles).toBe(1);
				expect(result.totalUpdatedLines).toBe(3);
				expect(modifiedContent).toBe([
					"# Project Demo",
					"- [ ] Meeting with Sunny [priority:: high] [due:: 2026-10-20] [assignee:: Sunny] [location:: 科学家博物馆]",
					"- [/] In progress task [start:: 2026-10-18]",
					"- [x] Done task [completion:: 2026-10-19]",
					"Some notes here",
				].join("\n"));
				expect(replacedContent).toBe(modifiedContent);
			});

			test("normalizeVaultTaskFormat converts dataview tasks to emoji format across vault", async () => {
				const registry = new StatusRegistry();
				const file = { path: "Projects/Server.md", basename: "Server", stat: { mtime: 1000 } };
				let content = [
					"- [ ] Server maintenance [due:: 2026-10-20] [location:: 10.1.130.42] [priority:: high]",
				].join("\n");

				let modifiedContent = "";
				const app = {
					vault: {
						getMarkdownFiles: () => [file],
						read: () => Promise.resolve(content),
						modify: (_f: any, val: string) => {
							modifiedContent = val;
							content = val;
							return Promise.resolve();
						},
					},
					metadataCache: {
						getFileCache: () => null,
					},
				};

				const plugin = {
					statusRegistry: registry,
					documentStore: {
						replaceDocumentContent: () => Promise.resolve(),
					},
				};

				const result = await normalizeVaultTaskFormat(app as any, plugin as any, "emoji");
				expect(result.totalUpdatedFiles).toBe(1);
				expect(result.totalUpdatedLines).toBe(1);
				expect(modifiedContent).toBe("- [ ] Server maintenance ⏫ 📅 2026-10-20 📍 10.1.130.42");
			});

			test("normalizeVaultTaskFormat ignores files with tasks: ignore frontmatter", async () => {
				const registry = new StatusRegistry();
				const file = { path: "Ignore.md", basename: "Ignore", stat: { mtime: 1000 } };
				let content = "- [ ] Task 📅 2026-10-20";
				let modifyCalled = false;

				const app = {
					vault: {
						getMarkdownFiles: () => [file],
						read: () => Promise.resolve(content),
						modify: () => {
							modifyCalled = true;
							return Promise.resolve();
						},
					},
					metadataCache: {
						getFileCache: () => ({ frontmatter: { tasks: "ignore" } }),
					},
				};

				const plugin = {
					statusRegistry: registry,
					documentStore: {
						replaceDocumentContent: () => Promise.resolve(),
					},
				};

				const result = await normalizeVaultTaskFormat(app as any, plugin as any, "dataview");
				expect(result.totalUpdatedFiles).toBe(0);
				expect(result.totalUpdatedLines).toBe(0);
				expect(modifyCalled).toBe(false);
			});

			test("DEFAULT_SETTINGS defaults preferredTaskFormat to dataview", async () => {
				const { DEFAULT_SETTINGS } = await import("../src/settings");
				expect(DEFAULT_SETTINGS.preferredTaskFormat).toBe("dataview");
			});

			test("supports dependsOn syntax across dataview inline fields", () => {
				const registry = new StatusRegistry();
				const t1 = parseLineWithStatus("- [ ] Task 1 [dependsOn:: task-a]", registry);
				expect(t1?.data.dependsOn).toBe("task-a");
				expect(t1?.data.description).toBe("Task 1");
			});

			test("task query filters support dependsOn and is(blocked) macro", () => {
				const registry = new StatusRegistry();
				const t1 = parseLineWithStatus("- [ ] Normal task", registry);
				const t2 = parseLineWithStatus("- [ ] Blocked task [dependsOn:: task-a]", registry);
				const t3 = parseLineWithStatus("- [x] Done task [dependsOn:: task-b]", registry);

				const records: any[] = [
					{ path: "test.md", lineNumber: 0, task: t1?.data, status: "TODO" },
					{ path: "test.md", lineNumber: 1, task: t2?.data, status: "TODO" },
					{ path: "test.md", lineNumber: 2, task: t3?.data, status: "DONE" },
				];

				const filterDependsOn = filterTaskRecordsByQuery(records, 'dependsOn = "task-a"');
				expect(filterDependsOn.length).toBe(1);
				expect(filterDependsOn[0].task.description).toBe("Blocked task");

				const filterIsBlocked = filterTaskRecordsByQuery(records, "is(blocked)");
				expect(filterIsBlocked.length).toBe(1);
				expect(filterIsBlocked[0].task.description).toBe("Blocked task");
			});

			test("emojiSuggest triggers on [dependsOn:: and suggests dependencies", async () => {
				const { TaskLiteEmojiSuggest } = await import("../src/suggest/emojiSuggest");
				const mockPlugin = {
					settings: {
						autoSuggestInEditor: true,
						assignees: [],
					},
					app: {},
					documentStore: {
						listCachedRecords: () => [
							{ task: { id: "auth-login", description: "Login flow" } },
						],
					},
				};
				const suggest = new TaskLiteEmojiSuggest(mockPlugin as any);
				const lineText = "- [ ] New task [dependsOn:: ";
				const editor = {
					getLine: () => lineText,
				};

				const trigger = suggest.onTrigger(
					{ line: 0, ch: lineText.length },
					editor as any,
					{ path: "test.md" } as any,
				);
				expect(trigger).not.toBeNull();
				expect(trigger?.query).toBe("depends-inline:");

				const suggestions = suggest.getSuggestions({ query: "depends-inline:" } as any);
				expect(suggestions.length).toBe(1);
				expect(suggestions[0].id).toBe("auth-login");
			});

			test("assignee autocomplete prioritizes default assignee at the top", async () => {
				const { TaskLiteEmojiSuggest } = await import("../src/suggest/emojiSuggest");
				// Mock localStorage
				const originalLocalStorage = globalThis.localStorage;
				(globalThis as any).window = {
					localStorage: {
						getItem: (k: string) => (k === "tasklite-my-identity" ? "Sunny" : null),
						setItem: () => {},
						removeItem: () => {},
					},
				};

				const mockPlugin = {
					settings: {
						autoSuggestInEditor: true,
						assignees: ["Alice", "Bob"],
					},
					app: {},
				};
				const suggest = new TaskLiteEmojiSuggest(mockPlugin as any);
				const suggestions = suggest.getSuggestions({ query: "assignee-inline:" } as any);

				expect(suggestions.length).toBe(3);
				expect(suggestions[0].name).toBe("Sunny"); // Default identity prioritized first!
				expect(suggestions[1].name).toBe("Alice");
				expect(suggestions[2].name).toBe("Bob");

				(globalThis as any).window.localStorage = originalLocalStorage;
			});

			test("isDataviewEnabled detects presence of active dataview plugin", async () => {
				const { isDataviewEnabled } = await import("../src/rendering/inlineFieldFallback");
				const appNoDataview = { plugins: { plugins: {}, enabledPlugins: new Set() } };
				expect(isDataviewEnabled(appNoDataview as any)).toBe(false);

				const appDisabledDataview = {
					plugins: {
						plugins: { dataview: {} },
						enabledPlugins: new Set(["other-plugin"]),
					},
				};
				expect(isDataviewEnabled(appDisabledDataview as any)).toBe(false);

				const appActiveDataview = {
					plugins: {
						plugins: { dataview: {} },
						enabledPlugins: new Set(["dataview"]),
					},
				};
				expect(isDataviewEnabled(appActiveDataview as any)).toBe(true);
			});

			const createMockEl = (tag: string) => {
				const children: any[] = [];
				const attrs: Record<string, string> = {};
				const elObj: any = {
					tagName: tag.toUpperCase(),
					className: "",
					textContent: "",
					children,
					appendChild(c: any) { children.push(c); },
					setAttribute(k: string, v: string) { attrs[k] = v; },
					getAttribute(k: string) { return attrs[k]; },
					classList: {
						contains(cls: string) {
							return elObj.className.split(" ").includes(cls);
						},
					},
					querySelector(sel: string) {
						if (sel.includes("key")) return children.find((c: any) => c.className?.includes("key"));
						if (sel.includes("value")) return children.find((c: any) => c.className?.includes("value"));
						return null;
					},
				};
				return elObj;
			};

			test("InlineFieldWidget renders proper fallback pill DOM with attributes", async () => {
				const { InlineFieldWidget } = await import("../src/rendering/inlineFieldFallback");
				const origDoc = globalThis.document;
				(globalThis as any).document = { createElement: createMockEl };

				const widget = new InlineFieldWidget("due", "2026-06-14", "[due:: 2026-06-14]");
				const dom = widget.toDOM();

				expect(dom.classList.contains("dataview")).toBe(true);
				expect(dom.classList.contains("inline-field")).toBe(true);
				expect(dom.classList.contains("tasklite-fallback")).toBe(true);
				expect(dom.getAttribute("data-dv-key")).toBe("due");
				expect(dom.getAttribute("data-dv-norm-key")).toBe("due");
				expect(dom.getAttribute("data-dv-value")).toBe("2026-06-14");

				const keyEl = dom.querySelector(".inline-field-key");
				expect(keyEl).not.toBeNull();
				expect(keyEl?.textContent).toBe("due");

				const valEl = dom.querySelector(".inline-field-value");
				expect(valEl).not.toBeNull();
				expect(valEl?.textContent).toBe("2026-06-14");

				(globalThis as any).document = origDoc;
			});

			test("createInlineFieldPostProcessor transforms inline fields when dataview is disabled", async () => {
				const { createInlineFieldPostProcessor } = await import("../src/rendering/inlineFieldFallback");
				const origDoc = globalThis.document;
				(globalThis as any).document = {
					createElement: createMockEl,
					createTreeWalker: () => ({ nextNode: () => false }),
				};

				const appNoDataview = { plugins: { plugins: {}, enabledPlugins: new Set() } };
				const processor = createInlineFieldPostProcessor(appNoDataview as any);

				let replacedWith: any = null;
				const mockA = {
					textContent: "due:: 2026-06-14",
					replaceWith: (el: any) => { replacedWith = el; },
				};
				const container = {
					querySelectorAll: (sel: string) => (sel.includes("a") ? [mockA] : []),
				};

				processor(container as any);

				expect(replacedWith).not.toBeNull();
				expect(replacedWith.getAttribute("data-dv-key")).toBe("due");
				expect(replacedWith.querySelector(".inline-field-value")?.textContent).toBe("2026-06-14");

				(globalThis as any).document = origDoc;
			});

			test("supports case-insensitive DQL field names and aliases", () => {
				const records: TaskDocumentRecord[] = [
					{
						task: parseTaskLine("- [x] Done task [completion:: 2026-05-20] [repeat:: every day] [blockedBy:: task-1] [assigned:: Alice] [loc:: Office]", "DONE")!.data,
						path: "Projects/Demo.md",
						basename: "Demo",
						lineNumber: 1,
						parentLine: null,
						depth: 0,
						hasChildren: false,
					},
				];

				// completion alias
				expect(filterTaskRecordsByQuery(records, 'completion = "2026-05-20"').length).toBe(1);
				expect(filterTaskRecordsByQuery(records, 'COMPLETION = "2026-05-20"').length).toBe(1);
				// repeat alias
				expect(filterTaskRecordsByQuery(records, 'repeat = "every day"').length).toBe(1);
				// blockedby / dependson aliases and case-insensitivity
				expect(filterTaskRecordsByQuery(records, 'blockedBy = "task-1"').length).toBe(1);
				expect(filterTaskRecordsByQuery(records, 'dependson = "task-1"').length).toBe(1);
				// assigned / assignee alias
				expect(filterTaskRecordsByQuery(records, 'assigned = "Alice"').length).toBe(1);
				// loc / location alias
				expect(filterTaskRecordsByQuery(records, 'loc = "Office"').length).toBe(1);
				expect(filterTaskRecordsByQuery(records, 'LOCATION = "Office"').length).toBe(1);

				// completed vs completion: completed checks checkbox, completion checks date attribute
				expect(filterTaskRecordsByQuery(records, "completed = true").length).toBe(1);
				expect(filterTaskRecordsByQuery(records, "completed = false").length).toBe(0);
				expect(filterTaskRecordsByQuery(records, 'completion = "2026-05-20"').length).toBe(1);
			});

			test("unifies recurrence serialization to [recurrence:: ...]", () => {
				const registry = new StatusRegistry();
				const task = parseTaskLine("- [ ] Recurring task 🔁 every day", registry)!.data;
				const record: TaskDocumentRecord = {
					task,
					path: "Test.md",
					basename: "Test",
					lineNumber: 1,
					parentLine: null,
					depth: 0,
					hasChildren: false,
				};
				const serialized = serializeTaskLine({ listMarker: "-", data: task }, "", registry, "dataview");
				expect(serialized).toBe("- [ ] Recurring task [recurrence:: every day]");
				// DQL queries can search by recurrence
				expect(filterTaskRecordsByQuery([record], 'recurrence = "every day"').length).toBe(1);
			});

			test("supports canonical DQL macros (happens, covers, is)", () => {
				const records: TaskDocumentRecord[] = [
					{
						task: parseTaskLine("- [/] In progress task [due:: 2026-05-20] [recurrence:: every week] [assignee:: Bob]", "IN_PROGRESS")!.data,
						path: "Projects/Demo.md",
						basename: "Demo",
						lineNumber: 1,
						parentLine: null,
						depth: 0,
						hasChildren: true,
					},
					{
						task: parseTaskLine("- [-] Cancelled task", "CANCELLED")!.data,
						path: "Projects/Demo.md",
						basename: "Demo",
						lineNumber: 2,
						parentLine: null,
						depth: 0,
						hasChildren: false,
					},
					{
						task: parseTaskLine("- [ ] Open subtask [dependsOn:: task-1]", "TODO")!.data,
						path: "Projects/Demo.md",
						basename: "Demo",
						lineNumber: 3,
						parentLine: 1,
						depth: 1,
						hasChildren: false,
					},
				];

				// Canonical happens
				expect(filterTaskRecordsByQuery(records, 'happens("2026-05-20")').length).toBe(1);

				// is(...) canonical states
				expect(filterTaskRecordsByQuery(records, "is(in_progress)").length).toBe(1);

				expect(filterTaskRecordsByQuery(records, "is(cancelled)").length).toBe(1);
				expect(filterTaskRecordsByQuery(records, "is(open)").length).toBe(2);
				expect(filterTaskRecordsByQuery(records, "is(blocked)").length).toBe(1);
				expect(filterTaskRecordsByQuery(records, "is(subtask)").length).toBe(1);

				expect(filterTaskRecordsByQuery(records, "is(root)").length).toBe(2);

				// Redundant aliases and unknown macros strictly rejected
				expect(() => filterTaskRecordsByQuery(records, "is(wip)")).toThrow();
				expect(() => filterTaskRecordsByQuery(records, "is(todo)")).toThrow();
				expect(() => filterTaskRecordsByQuery(records, "is(canceled)")).toThrow();
				expect(() => filterTaskRecordsByQuery(records, "is(waiting)")).toThrow();
				expect(() => filterTaskRecordsByQuery(records, "has(children)")).toThrow();
				expect(() => filterTaskRecordsByQuery(records, 'on("2026-05-20")')).toThrow();
				expect(() => filterTaskRecordsByQuery(records, 'happen("2026-05-20")')).toThrow();


















			});
		});
	});
});

