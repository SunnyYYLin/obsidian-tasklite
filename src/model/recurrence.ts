import type { TaskDates } from "./format";

export interface RecurrenceShift {
	amount: number;
	unit: "day" | "week" | "month" | "year";
}

export function parseRecurrenceRule(rule: string | null): RecurrenceShift | null {
	if (!rule) return null;
	const match = rule.trim().toLowerCase().match(/^every +(?:(\d+) +)?(day|days|week|weeks|month|months|year|years)(?: +when +done)?$/u);
	if (!match) return null;
	const amount = match[1] ? Number.parseInt(match[1], 10) : 1;
	if (!Number.isFinite(amount) || amount < 1) return null;
	const singular = (match[2] ?? "day").replace(/s$/u, "") as RecurrenceShift["unit"];
	return {amount, unit: singular};
}

export function shiftTaskDates(dates: TaskDates, shift: RecurrenceShift): TaskDates {
	return {
		...dates,
		start: shiftDate(dates.start, shift),
		scheduled: shiftDate(dates.scheduled, shift),
		due: shiftDate(dates.due, shift),
		done: null,
		cancelled: null,
	};
}

export function todayString(): string {
	return window.moment().format("YYYY-MM-DD");
}

function shiftDate(value: string | null, shift: RecurrenceShift): string | null {
	if (!value) return null;
	const next = window.moment(value, "YYYY-MM-DD", true);
	if (!next.isValid()) return value;
	return next.add(shift.amount, shift.unit).format("YYYY-MM-DD");
}
