import { RRule, Frequency, type Options } from "rrule";
import type { TaskDates } from "./format";

export interface RecurrenceRule {
	options: Partial<Options>;
	baseOnToday: boolean;
}

export function parseRecurrenceRule(rule: string | null): RecurrenceRule | null {
	if (!rule) return null;
	try {
		const match = rule.trim().match(/^([a-zA-Z0-9, !]+?)( +when +done)?$/i);
		if (!match) return null;

		const isolatedRuleText = (match[1] ?? "").trim();
		const baseOnToday = match[2] !== undefined;

		const options = RRule.parseText(isolatedRuleText);
		if (!options) return null;

		return {options, baseOnToday};
	} catch {
		return null;
	}
}

export function nextRecurrenceDates(dates: TaskDates, rule: RecurrenceRule, completedOn: string): TaskDates {
	const referenceDate = dates.due ?? dates.scheduled ?? dates.start;
	if (!referenceDate && !rule.baseOnToday) {
		return {...dates, done: null, cancelled: null};
	}

	const afterDate = rule.baseOnToday ? completedOn : referenceDate ?? completedOn;
	const dtstartDate = rule.baseOnToday ? afterDate : referenceDate ?? afterDate;
	const nextReferenceDate = nextDateAfter(afterDate, rule, dtstartDate);

	if (!nextReferenceDate) {
		return {...dates, done: null, cancelled: null};
	}

	return {
		...dates,
		start: shiftDateByDelta(dates.start, referenceDate, nextReferenceDate),
		scheduled: shiftDateByDelta(dates.scheduled, referenceDate, nextReferenceDate),
		due: shiftDateByDelta(dates.due, referenceDate, nextReferenceDate),
		done: null,
		cancelled: null,
	};
}

export function todayString(): string {
	return window.moment().format("YYYY-MM-DD");
}

function nextDateAfter(afterDate: string, rule: RecurrenceRule, dtstartDate: string): string | null {
	const after = parseDate(afterDate);
	const dtstart = parseDate(dtstartDate);
	if (!after || !dtstart) return null;

	const rrule = new RRule({
		...rule.options,
		dtstart: new Date(Date.UTC(dtstart.getUTCFullYear(), dtstart.getUTCMonth(), dtstart.getUTCDate())),
	});

	const afterEnd = new Date(Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate(), 23, 59, 59, 999));
	const next = rrule.after(afterEnd);
	if (!next) return null;

	let nextDate = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate()));

	const isMonthly = rule.options.freq === Frequency.MONTHLY;
	const isYearly = rule.options.freq === Frequency.YEARLY;

	if (isMonthly && !hasSpecificDate(rule.options)) {
		const skippingMonths = rule.options.interval ?? 1;
		let probe = new Date(afterEnd.getTime());
		while (isSkippingTooManyMonths(after, nextDate, skippingMonths)) {
			probe.setUTCDate(probe.getUTCDate() - 1);
			probe.setUTCHours(23, 59, 59, 999);
			const probeRule = new RRule({...rule.options, dtstart: new Date(Date.UTC(probe.getUTCFullYear(), probe.getUTCMonth(), probe.getUTCDate()))});
			const adjusted = probeRule.after(probe);
			if (!adjusted) break;
			nextDate = new Date(Date.UTC(adjusted.getUTCFullYear(), adjusted.getUTCMonth(), adjusted.getUTCDate()));
		}
	}

	if (isYearly) {
		const skippingYears = rule.options.interval ?? 1;
		let probe = new Date(afterEnd.getTime());
		while (isSkippingTooManyYears(after, nextDate, skippingYears)) {
			probe.setUTCDate(probe.getUTCDate() - 1);
			probe.setUTCHours(23, 59, 59, 999);
			const probeRule = new RRule({...rule.options, dtstart: new Date(Date.UTC(probe.getUTCFullYear(), probe.getUTCMonth(), probe.getUTCDate()))});
			const adjusted = probeRule.after(probe);
			if (!adjusted) break;
			nextDate = new Date(Date.UTC(adjusted.getUTCFullYear(), adjusted.getUTCMonth(), adjusted.getUTCDate()));
		}
	}

	return formatDate(nextDate);
}


function hasSpecificDate(options: Partial<Options>): boolean {
	return Boolean(options.bymonthday || options.byweekday || options.bynweekday);
}

function isSkippingTooManyMonths(after: Date, next: Date, skippingMonths: number): boolean {
	const diffMonths = (next.getUTCFullYear() - after.getUTCFullYear()) * 12 + (next.getUTCMonth() - after.getUTCMonth());
	return diffMonths > skippingMonths;
}

function isSkippingTooManyYears(after: Date, next: Date, skippingYears: number): boolean {
	return next.getUTCFullYear() - after.getUTCFullYear() > skippingYears;
}

function shiftDateByDelta(value: string | null, originalReference: string | null, nextReference: string): string | null {
	if (!value) return null;
	if (!originalReference) return nextReference;
	const dayOffset = daysBetween(originalReference, value);
	return addDays(nextReference, dayOffset);
}

function daysBetween(from: string, to: string): number {
	const fromDate = parseDate(from);
	const toDate = parseDate(to);
	if (!fromDate || !toDate) return 0;
	return Math.round((toDate.getTime() - fromDate.getTime()) / 86400000);
}

function addDays(value: string, days: number): string {
	const date = parseDate(value);
	if (!date) return value;
	date.setUTCDate(date.getUTCDate() + days);
	return formatDate(date);
}

function parseDate(value: string): Date | null {
	const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
	if (!match) return null;
	const year = Number.parseInt(match[1] ?? "", 10);
	const month = Number.parseInt(match[2] ?? "", 10);
	const day = Number.parseInt(match[3] ?? "", 10);
	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
	return date;
}

function formatDate(date: Date): string {
	const year = date.getUTCFullYear().toString().padStart(4, "0");
	const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
	const day = date.getUTCDate().toString().padStart(2, "0");
	return `${year}-${month}-${day}`;
}
