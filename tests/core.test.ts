import { describe, expect, test } from "bun:test";
import moment from "moment";
import { parseTaskLine, TASK_SYMBOLS } from "../src/model/format";
import { StatusRegistry } from "../src/model/status";
import { toggleTaskAtLine } from "../src/editor/toggle";
import type { TasksLiteSettings } from "../src/settings";

(globalThis as unknown as {window: {moment: typeof moment}}).window = {moment};

const settings: TasksLiteSettings = {
	setCreatedDate: false,
	setDoneDate: true,
	setCancelledDate: true,
	copySubtasksOnRecurrence: true,
	autoSuggestInEditor: true,
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

describe("TasksLite core", () => {
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

		expect(result?.replacement[0]).toContain("- [x] Ship MVP ✅");
	});

	test("creates a recurring parent with copied subtasks", () => {
		const registry = new StatusRegistry();
		const result = toggleTaskAtLine({
			lines: [
				`- [ ] Parent ${TASK_SYMBOLS.due} 2026-05-20 ${TASK_SYMBOLS.recurrence} every week`,
				"  - [x] Child done ✅ 2026-05-19 🆔 abc",
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
});
