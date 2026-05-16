import { describe, expect, test } from "bun:test";
import { parseTaskLine, TASK_SYMBOLS } from "../src/model/format";
import { StatusRegistry } from "../src/model/status";
import { toggleTaskAtLine } from "../src/editor/toggle";
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
});

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
