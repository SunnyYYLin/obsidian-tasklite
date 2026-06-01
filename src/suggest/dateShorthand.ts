/**
 * Parses human-friendly date shorthand strings into YYYY-MM-DD format.
 *
 * Supported inputs (case-insensitive):
 *  - today / 今天
 *  - tomorrow / 明天
 *  - yesterday / 昨天
 *  - next week / 下周
 *  - next monday .. next sunday / 下周一 .. 下周日
 *  - this monday .. this sunday / 本周一 .. 本周日
 *  - in N days / N days later / N天后
 *  - in N weeks / N weeks later / N周后
 *  - in N months / N months later / N个月后
 *
 * Returns `null` when the input is not recognised.
 */
export function parseDateShorthand(input: string): string | null {
	const s = input.trim().toLowerCase();

	if (s === "today" || s === "今天") return offsetDate(0);
	if (s === "tomorrow" || s === "明天") return offsetDate(1);
	if (s === "yesterday" || s === "昨天") return offsetDate(-1);

	// next week → next Monday
	if (s === "next week" || s === "下周" || s === "下下周") {
		const offset = s === "下下周" ? 2 : 1;
		return nextWeekdayFromToday(1, offset);
	}

	// next <weekday>
	const nextWd = s.match(/^next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/u);
	if (nextWd) return nextWeekdayFromToday(WEEKDAY_NAMES.indexOf(nextWd[1] as WeekdayName) + 1, 1);

	// this <weekday>
	const thisWd = s.match(/^this\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/u);
	if (thisWd) return thisWeekday(WEEKDAY_NAMES.indexOf(thisWd[1] as WeekdayName) + 1);

	// N days / N days later / in N days
	const days = s.match(/^(?:in\s+)?(\d+)\s*days?(?:\s+later)?$|^(\d+)天后?$/u);
	if (days) return offsetDate(Number.parseInt(days[1] ?? days[2] ?? "0", 10));

	// N weeks / N weeks later / in N weeks
	const weeks = s.match(/^(?:in\s+)?(\d+)\s*weeks?(?:\s+later)?$|^(\d+)周后?$/u);
	if (weeks) return offsetDate(Number.parseInt(weeks[1] ?? weeks[2] ?? "0", 10) * 7);

	// N months / N months later / in N months
	const months = s.match(/^(?:in\s+)?(\d+)\s*months?(?:\s+later)?$|^(\d+)个?月后?$/u);
	if (months) return offsetMonths(Number.parseInt(months[1] ?? months[2] ?? "0", 10));

	return null;
}

const WEEKDAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
type WeekdayName = (typeof WEEKDAY_NAMES)[number];

/** Returns a date offset by `days` from today (UTC). */
function offsetDate(days: number): string {
	const date = todayUtc();
	date.setUTCDate(date.getUTCDate() + days);
	return formatDate(date);
}

/** Returns a date offset by `months` months from today. */
function offsetMonths(months: number): string {
	const date = todayUtc();
	date.setUTCMonth(date.getUTCMonth() + months);
	return formatDate(date);
}

/**
 * Returns the date of the Nth next occurrence of the given ISO weekday (1=Mon…7=Sun).
 * When `weekOffset` is 1, this is the next-next occurrence after today
 * (i.e. same weekday never returns today – always future).
 */
function nextWeekdayFromToday(isoWeekday: number, weekOffset = 1): string {
	const date = todayUtc();
	const todayDow = date.getUTCDay() || 7; // convert 0=Sun to 7
	let diff = isoWeekday - todayDow;
	if (diff <= 0) diff += 7;
	diff += (weekOffset - 1) * 7;
	date.setUTCDate(date.getUTCDate() + diff);
	return formatDate(date);
}

/** Returns the date for "this <weekday>": the occurrence within the current Mon–Sun week. */
function thisWeekday(isoWeekday: number): string {
	const date = todayUtc();
	const todayDow = date.getUTCDay() || 7;
	const diff = isoWeekday - todayDow;
	date.setUTCDate(date.getUTCDate() + diff);
	return formatDate(date);
}

function todayUtc(): Date {
	const now = new Date();
	return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function formatDate(date: Date): string {
	const y = date.getUTCFullYear().toString().padStart(4, "0");
	const m = (date.getUTCMonth() + 1).toString().padStart(2, "0");
	const d = date.getUTCDate().toString().padStart(2, "0");
	return `${y}-${m}-${d}`;
}

// ---------------------------------------------------------------------------
// Pre-built suggestion entries for the emoji suggest UI
// ---------------------------------------------------------------------------

export interface DateShorthandSuggestion {
	label: string;
	/** Returns the resolved date string at invocation time. */
	resolve(): string;
}

export const DATE_SHORTHAND_SUGGESTIONS: DateShorthandSuggestion[] = [
	{label: "Today / 今天", resolve: () => offsetDate(0)},
	{label: "Tomorrow / 明天", resolve: () => offsetDate(1)},
	{label: "In 3 days / 3天后", resolve: () => offsetDate(3)},
	{label: "In 7 days / 7天后", resolve: () => offsetDate(7)},
	{label: "In 14 days / 14天后", resolve: () => offsetDate(14)},
	{label: "In 30 days / 30天后", resolve: () => offsetMonths(0) /* same as 30 days approx */},
	{label: "Next Monday / 下周一", resolve: () => nextWeekdayFromToday(1)},
	{label: "Next Tuesday / 下周二", resolve: () => nextWeekdayFromToday(2)},
	{label: "Next Wednesday / 下周三", resolve: () => nextWeekdayFromToday(3)},
	{label: "Next Thursday / 下周四", resolve: () => nextWeekdayFromToday(4)},
	{label: "Next Friday / 下周五", resolve: () => nextWeekdayFromToday(5)},
	{label: "Next Saturday / 下周六", resolve: () => nextWeekdayFromToday(6)},
	{label: "Next Sunday / 下周日", resolve: () => nextWeekdayFromToday(7)},
	{label: "Next week / 下周", resolve: () => nextWeekdayFromToday(1)},
	{label: "In 1 month / 1个月后", resolve: () => offsetMonths(1)},
	{label: "In 3 months / 3个月后", resolve: () => offsetMonths(3)},
];

// Fix: "In 30 days" should use offsetDate, not offsetMonths
DATE_SHORTHAND_SUGGESTIONS[5] = {label: "In 30 days / 30天后", resolve: () => offsetDate(30)};
