import type { TaskDates } from "./format";

export interface RecurrenceShift {
	amount: number;
	unit: "day" | "week" | "month" | "year";
	whenDone: boolean;
}

export function parseRecurrenceRule(rule: string | null): RecurrenceShift | null {
	if (!rule) return null;
	const match = rule.trim().toLowerCase().match(/^every +(?:(\d+) +)?(day|days|week|weeks|month|months|year|years)(?: +when +done)?$/u);
	if (!match) return null;
	const amount = match[1] ? Number.parseInt(match[1], 10) : 1;
	if (!Number.isFinite(amount) || amount < 1) return null;
	const singular = (match[2] ?? "day").replace(/s$/u, "") as RecurrenceShift["unit"];
	const whenDone = rule.trim().toLowerCase().endsWith(" when done");
	return {amount, unit: singular, whenDone};
}

export function shiftTaskDates(dates: TaskDates, shift: RecurrenceShift, completedOn: string): TaskDates {
	const originalReferenceDate = getReferenceDate(dates);
	if (originalReferenceDate === null && !shift.whenDone) {
		return {
			...dates,
			done: null,
			cancelled: null,
		};
	}
	const baseDate = shift.whenDone ? completedOn : originalReferenceDate ?? completedOn;
	const nextReferenceDate = shiftDate(baseDate, shift);
	return {
		...dates,
		start: nextOccurrenceDate(dates.start, originalReferenceDate, nextReferenceDate),
		scheduled: nextOccurrenceDate(dates.scheduled, originalReferenceDate, nextReferenceDate),
		due: nextOccurrenceDate(dates.due, originalReferenceDate, nextReferenceDate),
		done: null,
		cancelled: null,
	};
}

export function todayString(): string {
	return window.moment().format("YYYY-MM-DD");
}

function getReferenceDate(dates: TaskDates): string | null {
	return dates.due ?? dates.scheduled ?? dates.start;
}

function nextOccurrenceDate(value: string | null, originalReferenceDate: string | null, nextReferenceDate: string | null): string | null {
	if (!value || !nextReferenceDate) return null;
	if (!originalReferenceDate) return nextReferenceDate;
	const dayOffset = daysBetween(originalReferenceDate, value);
	return addDays(nextReferenceDate, dayOffset);
}

function shiftDate(value: string | null, shift: RecurrenceShift): string | null {
	if (!value) return null;
	const date = parseDate(value);
	if (!date) return value;
	if (shift.unit === "day") return addDays(value, shift.amount);
	if (shift.unit === "week") return addDays(value, shift.amount * 7);
	if (shift.unit === "month") return addMonthsClamped(value, shift.amount);
	return addYearsClamped(value, shift.amount);
}

function daysBetween(from: string, to: string): number {
	const fromDate = parseDate(from);
	const toDate = parseDate(to);
	if (!fromDate || !toDate) return 0;
	const millisecondsPerDay = 24 * 60 * 60 * 1000;
	return Math.round((toDate.getTime() - fromDate.getTime()) / millisecondsPerDay);
}

function addDays(value: string, days: number): string {
	const date = parseDate(value);
	if (!date) return value;
	date.setUTCDate(date.getUTCDate() + days);
	return formatDate(date);
}

function addMonthsClamped(value: string, months: number): string {
	const date = parseDate(value);
	if (!date) return value;
	const day = date.getUTCDate();
	const targetYear = date.getUTCFullYear();
	const targetMonth = date.getUTCMonth() + months;
	const lastDay = lastDayOfMonth(targetYear, targetMonth);
	return formatDate(new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay))));
}

function addYearsClamped(value: string, years: number): string {
	const date = parseDate(value);
	if (!date) return value;
	const targetYear = date.getUTCFullYear() + years;
	const month = date.getUTCMonth();
	const day = date.getUTCDate();
	const lastDay = lastDayOfMonth(targetYear, month);
	return formatDate(new Date(Date.UTC(targetYear, month, Math.min(day, lastDay))));
}

function lastDayOfMonth(year: number, zeroBasedMonth: number): number {
	return new Date(Date.UTC(year, zeroBasedMonth + 1, 0)).getUTCDate();
}

function parseDate(value: string): Date | null {
	const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
	if (!match) return null;
	const year = Number.parseInt(match[1] ?? "", 10);
	const month = Number.parseInt(match[2] ?? "", 10);
	const day = Number.parseInt(match[3] ?? "", 10);
	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
		return null;
	}
	return date;
}

function formatDate(date: Date): string {
	const year = date.getUTCFullYear().toString().padStart(4, "0");
	const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
	const day = date.getUTCDate().toString().padStart(2, "0");
	return `${year}-${month}-${day}`;
}
