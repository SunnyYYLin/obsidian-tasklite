import { describe, expect, test } from "bun:test";
import { parseTaskLine, TASK_SYMBOLS, normalizeLineIndentation } from "../src/model/format";
import { StatusRegistry } from "../src/model/status";
import { buildTaskTree } from "../src/model/tree";
import { taskIdentityKey } from "../src/model/taskIdentity";
import { TaskDocumentStore, type TaskDocumentRecord } from "../src/model/taskDocumentStore";
import { filterTaskRecordsByQuery } from "../src/model/taskQuery";
import { cancelTaskAtLine, clickTaskCheckboxAtLine, rightClickTaskCheckboxAtLine, toggleTaskAtLine, unfinishTaskAtLine } from "../src/editor/toggle";
import { reconcileExternalTaskCompletion } from "../src/editor/externalReconcileCore";
import { createTaskLiteCoreApi } from "../src/api/taskLiteCoreApi";
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

	test("editor checkbox right click uncancels a cancelled task and parent", () => {
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
			"  - [ ] Child",
		]);
	});

	test("right click uncancels a single cancelled task", () => {
		const registry = new StatusRegistry();
		const result = rightClickTaskCheckboxAtLine({
			lines: [`- [-] Cancelled task ${TASK_SYMBOLS.cancelled} 2026-05-16`],
			lineNumber: 0,
			metadata: null,
			registry,
			settings,
		});

		expect(result?.replacement).toEqual(["- [ ] Cancelled task"]);
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

		test("clicking an in-progress task finishes it", () => {
			const registry = new StatusRegistry();
			const result = clickTaskCheckboxAtLine({
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
			const registry = new StatusRegistry();
			const task = parseTaskLine("- [ ] ", "TODO");
			expect(task).not.toBeNull();
			expect(task!.data.description).toBe("");
		});

		test("body with only spaces produces empty description", () => {
			const registry = new StatusRegistry();
			const task = parseTaskLine("- [ ]   ", "TODO");
			expect(task).not.toBeNull();
			expect(task!.data.description).toBe("");
		});

		test("priority emoji is extracted from description", () => {
			const registry = new StatusRegistry();
			const task = parseTaskLine("- [ ] task 🔺", "TODO");
			expect(task).not.toBeNull();
			expect(task!.data.description).toBe("task");
			expect(task!.data.priority).toBe("highest");
		});

		test("lowest priority emoji is extracted", () => {
			const registry = new StatusRegistry();
			const task = parseTaskLine("- [ ] task ⏬", "TODO");
			expect(task).not.toBeNull();
			expect(task!.data.priority).toBe("lowest");
		});

		test("multiple dates are all extracted", () => {
			const registry = new StatusRegistry();
			const task = parseTaskLine("- [ ] task 🛫 2026-01-01 📅 2026-12-31", "TODO");
			expect(task).not.toBeNull();
			expect(task!.data.dates.start).toBe("2026-01-01");
			expect(task!.data.dates.due).toBe("2026-12-31");
			expect(task!.data.description).toBe("task");
		});

		test("block link is extracted", () => {
			const registry = new StatusRegistry();
			const task = parseTaskLine("- [ ] task ^block-id", "TODO");
			expect(task).not.toBeNull();
			expect(task!.data.blockLink).toBe("^block-id");
			expect(task!.data.description).toBe("task");
		});

		test("tags are extracted from description", () => {
			const registry = new StatusRegistry();
			const task = parseTaskLine("- [ ] task #work #urgent", "TODO");
			expect(task).not.toBeNull();
			expect(task!.data.tags).toEqual(["#work", "#urgent"]);
		});

		test("unicode emoji in description is preserved", () => {
			const registry = new StatusRegistry();
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

	test("createTask can create a line task with bodyText and refLink", async () => {
		let fileContent = "";
		const file = createTestFile("tasks.md", "tasks");
		const api = createTestCoreApi({
			vault: {
				getAbstractFileByPath: () => file,
				read: () => Promise.resolve(""),
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
			description: "Buy milk",
			refLink: "[[Shopping List]]",
			bodyText: "Make sure it's organic.\nCheck the date.",
			path: "tasks.md",
		});

		expect(fileContent).toBe("- [ ] Buy milk [[Shopping List]]\n\nMake sure it's organic.\nCheck the date.\n");
	});

	test("createTask can create a frontmatter task with bodyText and refLink", async () => {
		const fmState: Record<string, unknown> = {};
		let fileContent = "";
		const file = createTestFile("Work/project.md", "project");
		const api = createTestCoreApi({
			vault: {
				getAbstractFileByPath: () => null,
				create: (path: string, content: string) => {
					expect(path).toBe("Work/project.md");
					fileContent = "---";
					return Promise.resolve(file);
				},
				read: () => Promise.resolve(fileContent),
				modify: (_f: unknown, content: string) => {
					fileContent = content;
					return Promise.resolve();
				},
			},
			fileManager: {
				processFrontMatter: (_f: unknown, fn: (fm: Record<string, unknown>) => void) => {
					fn(fmState);
					fileContent = "---\ntask: true\nrefLink: " + fmState.refLink + "\n---";
					return Promise.resolve();
				},
			},
		});

		await api.createTask({
			description: "New Project",
			refLink: "[[Project Plan]]",
			bodyText: "Detailed notes go here.",
			path: "Work/project.md",
			isFileTask: true,
		});

		expect(fmState.task).toBe(true);
		expect(fmState.refLink).toBe("[[Project Plan]]");
		expect(fileContent).toContain("---\ntask: true\nrefLink: [[Project Plan]]\n---");
		expect(fileContent).toContain("\nDetailed notes go here.\n");
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
				start: null,
				created: null,
				scheduled: input.scheduled ?? null,
				due: input.due ?? null,
				done: null,
				cancelled: null,
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
