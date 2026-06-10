/**
 * Dynamic date shorthand parser and suggestion engine.
 *
 * All *matching* is done on English input (case-insensitive).
 * All *display labels* are localised via the locale helper.
 *
 * Supported patterns:
 *   today / yesterday / tomorrow
 *   in N days / N days later / N days ago
 *   in N weeks / N weeks later / N weeks ago
 *   in N months / N months later / N months ago
 *   next <weekday>       – next future occurrence (always ≥ tomorrow)
 *   this <weekday>       – this week's occurrence (may be today)
 *   next week            – next Monday
 *   last week            – last Monday
 *   YYYY-MM-DD           – passthrough
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DateSuggestionEntry {
	/** English text written into the note. */
	englishText: string;
	/** Resolved YYYY-MM-DD date. */
	resolved: string;
	/** Localised label shown in the dropdown. */
	localLabel: string;
}

// ---------------------------------------------------------------------------
// Public: dynamic suggestions list
// ---------------------------------------------------------------------------

/**
 * Given the raw text the user typed after a date emoji field,
 * return up to `limit` date suggestion entries.
 *
 * When `query` is empty, returns a set of "hint" entries showing available patterns.
 */
export function getDateSuggestions(query: string, limit = 8): DateSuggestionEntry[] {
	const q = query.trim().toLowerCase();

	if (!q) return getHintEntries().slice(0, limit);

	const results: DateSuggestionEntry[] = [];

	// 1. Try to parse the query directly as a date shorthand
	const direct = parseDateShorthand(q);
	if (direct) {
		results.push({
			englishText: normalizeEnglishText(q),
			resolved: direct,
			localLabel: localizeQuery(q, direct),
		});
	}

	// 2. Try to parse Chinese shorthand (converts to equivalent English first)
	const fromChinese = parseChineseShorthand(q);
	if (fromChinese && fromChinese.resolved !== direct) {
		results.push(fromChinese);
	}

	// 3. Add matching pattern hints
	for (const hint of getHintEntries()) {
		if (results.length >= limit) break;
		if (hintMatchesQuery(hint, q) && !results.some((r) => r.resolved === hint.resolved)) {
			results.push(hint);
		}
	}

	// 4. If the query looks like a number, generate "in N days/weeks" entries
	if (/^\d+$/u.test(q)) {
		const n = Number.parseInt(q, 10);
		if (!Number.isNaN(n) && n > 0 && n <= 3650) {
			const daysEntry = buildNDaysEntry(n);
			if (!results.some((r) => r.resolved === daysEntry.resolved)) results.push(daysEntry);
			if (results.length < limit) {
				const weeksEntry = buildNWeeksEntry(n);
				if (!results.some((r) => r.resolved === weeksEntry.resolved)) results.push(weeksEntry);
			}
			if (results.length < limit && n <= 24) {
				const monthsEntry = buildNMonthsEntry(n);
				if (!results.some((r) => r.resolved === monthsEntry.resolved)) results.push(monthsEntry);
			}
		}
	}

	// 5. Prefix "next " auto-completion for weekday initials
	if (/^n[a-z]*$/u.test(q) || /^next\s*$/u.test(q)) {
		for (const [isoWd, names] of WEEKDAY_ENTRIES) {
			if (results.length >= limit) break;
			const englishText = `next ${names.en}`;
			const resolved = nextWeekdayFromToday(isoWd, 1);
			if (!results.some((r) => r.resolved === resolved && r.englishText === englishText)) {
				results.push({
					englishText,
					resolved,
					localLabel: buildLabel(names[currentLocale()], resolved),
				});
			}
		}
	}

	return results.slice(0, limit);
}

/**
 * Try to parse a query string as an English date shorthand.
 * Returns YYYY-MM-DD or null.
 */
export function parseDateShorthand(input: string): string | null {
	const s = input.trim().toLowerCase();
	if (!s) return null;

	if (s === "today") return offsetDate(0);
	if (s === "yesterday") return offsetDate(-1);
	if (s === "tomorrow") return offsetDate(1);

	// YYYY-MM-DD passthrough
	if (/^\d{4}-\d{2}-\d{2}$/u.test(s)) return s;

	// MM-DD or M-D (e.g. 6-1 or 12-25)
	const monthDayMatch = s.match(/^(\d{1,2})-(\d{1,2})$/u);
	if (monthDayMatch) {
		const year = todayUtc().getUTCFullYear();
		const m = Number.parseInt(monthDayMatch[1] ?? "0", 10);
		const d = Number.parseInt(monthDayMatch[2] ?? "0", 10);
		if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
			if (isValidDate(year, m, d)) {
				return `${year}-${m.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`;
			}
		}
	}

	// DD or D (e.g. 11 or 5)
	const dayMatch = s.match(/^(\d{1,2})$/u);
	if (dayMatch) {
		const today = todayUtc();
		const year = today.getUTCFullYear();
		const month = today.getUTCMonth() + 1;
		const d = Number.parseInt(dayMatch[1] ?? "0", 10);
		if (d >= 1 && d <= 31) {
			if (isValidDate(year, month, d)) {
				return `${year}-${month.toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`;
			}
		}
	}

	// next week / last week
	if (s === "next week") return nextWeekdayFromToday(1, 1);
	if (s === "last week") return nextWeekdayFromToday(1, -1);

	// next <weekday> / this <weekday>
	const nextWdMatch = s.match(/^next\s+([a-z]+)$/u);
	if (nextWdMatch) {
		const wd = resolveWeekday(nextWdMatch[1] ?? "");
		if (wd !== null) return nextWeekdayFromToday(wd, 1);
	}
	const thisWdMatch = s.match(/^this\s+([a-z]+)$/u);
	if (thisWdMatch) {
		const wd = resolveWeekday(thisWdMatch[1] ?? "");
		if (wd !== null) return thisWeekday(wd);
	}
	const lastWdMatch = s.match(/^last\s+([a-z]+)$/u);
	if (lastWdMatch) {
		const wd = resolveWeekday(lastWdMatch[1] ?? "");
		if (wd !== null) return nextWeekdayFromToday(wd, -1);
	}

	// in N days / N days later / N days ago
	const daysMatch = s.match(/^(?:in\s+)?(\d+)\s*days?(?:\s+(?:later|ago))?$/u);
	if (daysMatch) {
		const n = Number.parseInt(daysMatch[1] ?? "0", 10);
		const sign = s.includes("ago") ? -1 : 1;
		return offsetDate(n * sign);
	}

	// in N weeks / N weeks later / N weeks ago
	const weeksMatch = s.match(/^(?:in\s+)?(\d+)\s*weeks?(?:\s+(?:later|ago))?$/u);
	if (weeksMatch) {
		const n = Number.parseInt(weeksMatch[1] ?? "0", 10);
		const sign = s.includes("ago") ? -1 : 1;
		return offsetDate(n * 7 * sign);
	}

	// in N months / N months later / N months ago
	const monthsMatch = s.match(/^(?:in\s+)?(\d+)\s*months?(?:\s+(?:later|ago))?$/u);
	if (monthsMatch) {
		const n = Number.parseInt(monthsMatch[1] ?? "0", 10);
		const sign = s.includes("ago") ? -1 : 1;
		return offsetMonths(n * sign);
	}

	return null;
}

// ---------------------------------------------------------------------------
// Chinese shorthand parser
// ---------------------------------------------------------------------------

function parseChineseShorthand(s: string): DateSuggestionEntry | null {
	if (s === "今天") return {englishText: "today", resolved: offsetDate(0), localLabel: buildLabel(zhLabel("today"), offsetDate(0))};
	if (s === "明天") return {englishText: "tomorrow", resolved: offsetDate(1), localLabel: buildLabel(zhLabel("tomorrow"), offsetDate(1))};
	if (s === "昨天") return {englishText: "yesterday", resolved: offsetDate(-1), localLabel: buildLabel(zhLabel("yesterday"), offsetDate(-1))};
	if (s === "下周" || s === "下周一") {
		const resolved = nextWeekdayFromToday(1, 1);
		return {englishText: "next monday", resolved, localLabel: buildLabel("下周一", resolved)};
	}
	if (s === "后天") {
		const resolved = offsetDate(2);
		return {englishText: "in 2 days", resolved, localLabel: buildLabel("后天", resolved)};
	}
	if (s === "大后天") {
		const resolved = offsetDate(3);
		return {englishText: "in 3 days", resolved, localLabel: buildLabel("大后天", resolved)};
	}
	if (s === "前天") {
		const resolved = offsetDate(-2);
		return {englishText: "2 days ago", resolved, localLabel: buildLabel("前天", resolved)};
	}

	// N天后 / N天前
	const cnDaysAfter = s.match(/^(\d+)天后?$/u);
	if (cnDaysAfter) {
		const n = Number.parseInt(cnDaysAfter[1] ?? "0", 10);
		const resolved = offsetDate(n);
		const englishText = `in ${n} days`;
		return {englishText, resolved, localLabel: buildLabel(`${n}天后`, resolved)};
	}
	const cnDaysBefore = s.match(/^(\d+)天前$/u);
	if (cnDaysBefore) {
		const n = Number.parseInt(cnDaysBefore[1] ?? "0", 10);
		const resolved = offsetDate(-n);
		const englishText = `${n} days ago`;
		return {englishText, resolved, localLabel: buildLabel(`${n}天前`, resolved)};
	}

	// N周后 / N周前
	const cnWeeksAfter = s.match(/^(\d+)周后?$/u);
	if (cnWeeksAfter) {
		const n = Number.parseInt(cnWeeksAfter[1] ?? "0", 10);
		const resolved = offsetDate(n * 7);
		const englishText = `in ${n} weeks`;
		return {englishText, resolved, localLabel: buildLabel(`${n}周后`, resolved)};
	}

	// N个月后 / N月后
	const cnMonthsAfter = s.match(/^(\d+)个?月后?$/u);
	if (cnMonthsAfter) {
		const n = Number.parseInt(cnMonthsAfter[1] ?? "0", 10);
		const resolved = offsetMonths(n);
		const englishText = `in ${n} months`;
		return {englishText, resolved, localLabel: buildLabel(`${n}个月后`, resolved)};
	}

	// 下周X
	const cnNextWeekday = s.match(/^下周([一二三四五六日天])$/u);
	if (cnNextWeekday) {
		const wd = CN_WEEKDAY_MAP[cnNextWeekday[1] ?? ""] ?? null;
		if (wd !== null) {
			const resolved = nextWeekdayFromToday(wd, 1);
			const englishText = `next ${WEEKDAY_EN[wd - 1]}`;
			return {englishText, resolved, localLabel: buildLabel(`下周${cnNextWeekday[1]}`, resolved)};
		}
	}

	// 本周X / 这周X
	const cnThisWeekday = s.match(/^(?:本|这)周([一二三四五六日天])$/u);
	if (cnThisWeekday) {
		const wd = CN_WEEKDAY_MAP[cnThisWeekday[1] ?? ""] ?? null;
		if (wd !== null) {
			const resolved = thisWeekday(wd);
			const englishText = `this ${WEEKDAY_EN[wd - 1]}`;
			return {englishText, resolved, localLabel: buildLabel(`本周${cnThisWeekday[1]}`, resolved)};
		}
	}

	return null;
}

// ---------------------------------------------------------------------------
// Hint entries (shown when query is empty)
// ---------------------------------------------------------------------------

function getHintEntries(): DateSuggestionEntry[] {
	const loc = currentLocale();
	const entries: DateSuggestionEntry[] = [
		{englishText: "today", resolved: offsetDate(0), localLabel: buildLabel(loc === "zh" ? "今天" : "today", offsetDate(0))},
		{englishText: "tomorrow", resolved: offsetDate(1), localLabel: buildLabel(loc === "zh" ? "明天" : "tomorrow", offsetDate(1))},
		{englishText: "yesterday", resolved: offsetDate(-1), localLabel: buildLabel(loc === "zh" ? "昨天" : "yesterday", offsetDate(-1))},
		{englishText: "in 3 days", resolved: offsetDate(3), localLabel: buildLabel(loc === "zh" ? "3天后" : "in 3 days", offsetDate(3))},
		{englishText: "in 7 days", resolved: offsetDate(7), localLabel: buildLabel(loc === "zh" ? "7天后" : "in 7 days", offsetDate(7))},
		{englishText: "in 14 days", resolved: offsetDate(14), localLabel: buildLabel(loc === "zh" ? "14天后" : "in 14 days", offsetDate(14))},
		{englishText: "in 1 month", resolved: offsetMonths(1), localLabel: buildLabel(loc === "zh" ? "1个月后" : "in 1 month", offsetMonths(1))},
		{englishText: "in 3 months", resolved: offsetMonths(3), localLabel: buildLabel(loc === "zh" ? "3个月后" : "in 3 months", offsetMonths(3))},
	];
	// Append next-weekday entries
	for (const [isoWd, names] of WEEKDAY_ENTRIES) {
		const englishText = `next ${names.en}`;
		const resolved = nextWeekdayFromToday(isoWd, 1);
		entries.push({englishText, resolved, localLabel: buildLabel(names[loc], resolved)});
	}
	return entries;
}

function hintMatchesQuery(hint: DateSuggestionEntry, q: string): boolean {
	const labelPart = hint.localLabel.split("  →  ")[0] ?? "";
	return (
		hint.englishText.includes(q) ||
		labelPart.toLowerCase().includes(q)
	);
}

// ---------------------------------------------------------------------------
// Label builders
// ---------------------------------------------------------------------------

function buildLabel(humanText: string, resolved: string): string {
	if (humanText === resolved) return resolved;
	return `${humanText}  →  ${resolved}`;
}

function localizeQuery(q: string, resolved: string): string {
	const loc = currentLocale();
	if (loc !== "zh") return buildLabel(q, resolved);

	// Map common English terms to Chinese for display
	const zh = q
		.replace(/^today$/u, "今天")
		.replace(/^tomorrow$/u, "明天")
		.replace(/^yesterday$/u, "昨天")
		.replace(/^in (\d+) days?$/u, (_, n) => `${n}天后`)
		.replace(/^(\d+) days? ago$/u, (_, n) => `${n}天前`)
		.replace(/^in (\d+) weeks?$/u, (_, n) => `${n}周后`)
		.replace(/^in (\d+) months?$/u, (_, n) => `${n}个月后`)
		.replace(/^next week$/u, "下周")
		.replace(/^next (monday|mon)$/iu, "下周一")
		.replace(/^next (tuesday|tue)$/iu, "下周二")
		.replace(/^next (wednesday|wed)$/iu, "下周三")
		.replace(/^next (thursday|thu)$/iu, "下周四")
		.replace(/^next (friday|fri)$/iu, "下周五")
		.replace(/^next (saturday|sat)$/iu, "下周六")
		.replace(/^next (sunday|sun)$/iu, "下周日");
	return buildLabel(zh === q ? q : zh, resolved);
}

function zhLabel(englishKey: string): string {
	const map: Record<string, string> = {
		today: "今天",
		tomorrow: "明天",
		yesterday: "昨天",
		"next week": "下周",
	};
	return map[englishKey] ?? englishKey;
}

// ---------------------------------------------------------------------------
// N-entry builders (used for numeric queries)
// ---------------------------------------------------------------------------

function buildNDaysEntry(n: number): DateSuggestionEntry {
	const loc = currentLocale();
	const resolved = offsetDate(n);
	const englishText = `in ${n} day${n === 1 ? "" : "s"}`;
	const localText = loc === "zh" ? `${n}天后` : englishText;
	return {englishText, resolved, localLabel: buildLabel(localText, resolved)};
}

function buildNWeeksEntry(n: number): DateSuggestionEntry {
	const loc = currentLocale();
	const resolved = offsetDate(n * 7);
	const englishText = `in ${n} week${n === 1 ? "" : "s"}`;
	const localText = loc === "zh" ? `${n}周后` : englishText;
	return {englishText, resolved, localLabel: buildLabel(localText, resolved)};
}

function buildNMonthsEntry(n: number): DateSuggestionEntry {
	const loc = currentLocale();
	const resolved = offsetMonths(n);
	const englishText = `in ${n} month${n === 1 ? "" : "s"}`;
	const localText = loc === "zh" ? `${n}个月后` : englishText;
	return {englishText, resolved, localLabel: buildLabel(localText, resolved)};
}

// ---------------------------------------------------------------------------
// Normalizer: make sure written English is canonical
// ---------------------------------------------------------------------------

function normalizeEnglishText(q: string): string {
	// "n days" → "in n days", "n weeks later" → "in n weeks", etc.
	const dayMatch = q.match(/^(?:in\s+)?(\d+)\s*days?(?:\s+later)?$/u);
	if (dayMatch) return `in ${dayMatch[1]} day${Number(dayMatch[1]) === 1 ? "" : "s"}`;
	const weekMatch = q.match(/^(?:in\s+)?(\d+)\s*weeks?(?:\s+later)?$/u);
	if (weekMatch) return `in ${weekMatch[1]} week${Number(weekMatch[1]) === 1 ? "" : "s"}`;
	const monthMatch = q.match(/^(?:in\s+)?(\d+)\s*months?(?:\s+later)?$/u);
	if (monthMatch) return `in ${monthMatch[1]} month${Number(monthMatch[1]) === 1 ? "" : "s"}`;
	return q;
}

// ---------------------------------------------------------------------------
// Weekday data
// ---------------------------------------------------------------------------

const WEEKDAY_EN = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

const WEEKDAY_ENTRIES: Array<[number, {en: string; zh: string}]> = [
	[1, {en: "monday",    zh: "下周一"}],
	[2, {en: "tuesday",   zh: "下周二"}],
	[3, {en: "wednesday", zh: "下周三"}],
	[4, {en: "thursday",  zh: "下周四"}],
	[5, {en: "friday",    zh: "下周五"}],
	[6, {en: "saturday",  zh: "下周六"}],
	[7, {en: "sunday",    zh: "下周日"}],
];

const WEEKDAY_ALIASES: Record<string, number> = {
	monday: 1, mon: 1, mo: 1,
	tuesday: 2, tue: 2, tu: 2,
	wednesday: 3, wed: 3, we: 3,
	thursday: 4, thu: 4, th: 4,
	friday: 5, fri: 5, fr: 5,
	saturday: 6, sat: 6, sa: 6,
	sunday: 7, sun: 7, su: 7,
};

const CN_WEEKDAY_MAP: Record<string, number> = {
	"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 7, "天": 7,
};

function resolveWeekday(name: string): number | null {
	return WEEKDAY_ALIASES[name.toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Date arithmetic
// ---------------------------------------------------------------------------

function offsetDate(days: number): string {
	const date = todayUtc();
	date.setUTCDate(date.getUTCDate() + days);
	return formatDate(date);
}

function offsetMonths(months: number): string {
	const date = todayUtc();
	date.setUTCMonth(date.getUTCMonth() + months);
	return formatDate(date);
}

/**
 * Next occurrence of ISO weekday `isoWd` (1=Mon … 7=Sun).
 * `weekOffset` positive = future, negative = past.
 * Never returns today when weekOffset=1.
 */
function nextWeekdayFromToday(isoWd: number, weekOffset = 1): string {
	const date = todayUtc();
	const todayDow = date.getUTCDay() || 7;
	let diff = isoWd - todayDow;
	if (weekOffset > 0 && diff <= 0) diff += 7;
	if (weekOffset < 0 && diff >= 0) diff -= 7;
	diff += (weekOffset > 0 ? weekOffset - 1 : weekOffset + 1) * 7;
	date.setUTCDate(date.getUTCDate() + diff);
	return formatDate(date);
}

function thisWeekday(isoWd: number): string {
	const date = todayUtc();
	const todayDow = date.getUTCDay() || 7;
	date.setUTCDate(date.getUTCDate() + (isoWd - todayDow));
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

function isValidDate(year: number, month: number, day: number): boolean {
	const d = new Date(Date.UTC(year, month - 1, day));
	return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

// ---------------------------------------------------------------------------
// Locale helper (mirrors i18n.ts logic without importing it to keep this module pure)
// ---------------------------------------------------------------------------

function currentLocale(): "zh" | "en" {
	const maybeWindow = globalThis as {window?: {moment?: {locale?: () => string}}; navigator?: {language?: string}};
	const locale = (maybeWindow.window?.moment?.locale?.() ?? maybeWindow.navigator?.language ?? "en").toLowerCase();
	return locale.startsWith("zh") ? "zh" : "en";
}
