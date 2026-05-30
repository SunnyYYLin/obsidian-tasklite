import { describe, expect, test } from "bun:test";
import { parseTaskLine, TASK_SYMBOLS } from "../src/model/format";
import { StatusRegistry } from "../src/model/status";
import { fieldsFromTaskLine, taskLineFromFields } from "../src/model/taskLineFields";
import { TaskDocumentStore } from "../src/model/taskDocumentStore";
import { cancelTaskAtLine, clickTaskCheckboxAtLine, rightClickTaskCheckboxAtLine, toggleTaskAtLine, unfinishTaskAtLine } from "../src/editor/toggle";
import { reconcileExternalTaskCompletion } from "../src/editor/externalReconcileCore";
import { createTaskLiteCoreApi } from "../src/api/taskLiteCoreApi";
import { createTasksApiV1FromCore } from "../src/compat/tasksApi";
import type TaskLitePlugin from "../src/main";
import type { TaskLiteSettings } from "../src/settings";

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
	statusSettings: {
		coreStatuses: [
			{symbol: " ", name: "Todo", nextStatusSymbol: "x", availableAsCommand: true, type: "TODO"},
			{symbol: "x", name: "Done", nextStatusSymbol: " ", availableAsCommand: true, type: "DONE"},
		],
		customStatuses: [
			{symbol: "/", name: "In progress", nextStatusSymbol: "x", availableAsCommand: true, type: "IN_PROGRESS"},
			{symbol: "-", name: "Cancelled", nextStatusSymbol: " ", availableAsCommand: true, type: "CANCELLED"},
		],
	},
};

describe("TaskLite core", () => {
	test("parses Tasks-compatible emoji metadata", () => {
		const registry = new StatusRegistry();
		const task = parseTaskLine(`- [ ] Ship MVP ${TASK_SYMBOLS.due} 2026-05-20 ${TASK_SYMBOLS.recurrence} every week`, registry.get(" "));

		expect(task?.metadata.description).toBe("Ship MVP");
		expect(task?.metadata.dates.due).toBe("2026-05-20");
		expect(task?.metadata.recurrence).toBe("every week");
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

	test("exposes recurring toggles through the Tasks API shim", () => {
		const api = createTestTasksApi();

		const result = api.executeToggleTaskDoneCommand(
			`- [ ] Parent ${TASK_SYMBOLS.due} 2026-05-20 ${TASK_SYMBOLS.recurrence} every week`,
			"tasks.md",
		);

		const lines: string[] = result.split("\n");
		expect(lines).toEqual([
			`- [ ] Parent ${TASK_SYMBOLS.due} 2026-05-27 ${TASK_SYMBOLS.recurrence} every week`,
			expect.stringContaining(`- [x] Parent ${TASK_SYMBOLS.due} 2026-05-20`),
		]);
	});

	test("normalizes done dates for single-line Tasks API toggles", () => {
		const api = createTestTasksApi();

		const result = api.executeToggleTaskDoneCommand("- [x] Ship", "tasks.md");

		expect(result).toBe(`- [x] Ship ${TASK_SYMBOLS.done} 2026-05-16`);
	});

	test("copies subtasks for Tasks API toggles when the source file is open", () => {
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
		const api = createTestTasksApi({workspace: {activeEditor: view, getLeavesOfType: () => []}});

		const result = api.executeToggleTaskDoneCommand(
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

	test("uses open file context when Tasks API passes an already-checked child line", () => {
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
		const api = createTestTasksApi({workspace: {activeEditor: view, getLeavesOfType: () => []}});

		const result = api.executeToggleTaskDoneCommand("- [x] Second child", "tasks.md");

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
		expect(await api.finishTask("tasks.md", 2)).toBe(true);
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

		expect(await api.cancelTask("tasks.md", 2)).toBe(true);
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

		expect(await api.cancelTask("tasks.md", 0)).toBe(true);
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

	test("opens create and edit task modals through the Tasks API shim", async () => {
		const calls: Array<{title: string; initialLine: string}> = [];
		const plugin = createTestPlugin();
		const api = createTasksApiV1FromCore(
			plugin.api,
			plugin,
			(options) => {
				calls.push({title: options.title, initialLine: options.initialLine});
				return Promise.resolve(`${options.title}: ${options.initialLine}`);
			},
		);

		expect(await api.createTaskLineModal()).toBe("Create task: ");
		expect(await api.editTaskLineModal("- [ ] Existing")).toBe("Edit task: - [ ] Existing");
		expect(calls).toEqual([
			{title: "Create task", initialLine: ""},
			{title: "Edit task", initialLine: "- [ ] Existing"},
		]);
	});

	test("round-trips modal fields through TaskLite Markdown", () => {
		const registry = new StatusRegistry();
		const fields = fieldsFromTaskLine(`- [ ] Ship ${TASK_SYMBOLS.due} 2026-05-20 ${TASK_SYMBOLS.recurrence} every week`, registry);
		fields.statusSymbol = "x";
		fields.done = "2026-05-16";
		fields.id = "abc";

		expect(taskLineFromFields(fields, registry)).toBe(
			`- [x] Ship ${TASK_SYMBOLS.due} 2026-05-20 ${TASK_SYMBOLS.done} 2026-05-16 ${TASK_SYMBOLS.recurrence} every week ${TASK_SYMBOLS.id} abc`,
		);
	});

	test("removes done date when editing a task to cancelled", () => {
		const registry = new StatusRegistry();
		const fields = fieldsFromTaskLine(`- [x] Ship ${TASK_SYMBOLS.done} 2026-05-16`, registry);
		fields.statusSymbol = "-";
		fields.cancelled = "2026-05-17";

		expect(taskLineFromFields(fields, registry)).toBe(`- [-] Ship ${TASK_SYMBOLS.cancelled} 2026-05-17`);
	});

	test("preserves indentation and list marker when round-tripping edited tasks", () => {
		const registry = new StatusRegistry();
		const original = `  * [ ] Child task ${TASK_SYMBOLS.due} 2026-05-20`;
		const fields = fieldsFromTaskLine(original, registry);
		fields.description = "Edited child";

		expect(taskLineFromFields(fields, registry, original)).toBe(`  * [ ] Edited child ${TASK_SYMBOLS.due} 2026-05-20`);
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

		expect(task?.metadata.recurrence).toBe("every week");
		expect(task?.metadata.onCompletion).toBe("delete");
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
		events.get("modify")?.(secondFile);
		await new Promise((resolve) => setTimeout(resolve, 250));
		expect(await store.listRecords()).toHaveLength(2);
		expect(readCount).toBe(4);
	});
});

function createTestTasksApi(app: Record<string, unknown> = {}) {
	const plugin = createTestPlugin(app);
	return createTasksApiV1FromCore(plugin.api, plugin);
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
