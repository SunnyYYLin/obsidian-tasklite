import type { TaskDocumentRecord } from "./taskDocumentStore";

export class TaskQueryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TaskQueryError";
	}
}

type TokenType =
	| "identifier"
	| "string"
	| "boolean"
	| "null"
	| "operator"
	| "paren"
	| "comma"
	| "eof";

interface Token {
	type: TokenType;
	value: string;
	position: number;
}

type LiteralValue = string | number | boolean | null;

export type MacroName = "happens" | "is" | "covers";

type Expression =
	| {
			type: "binary";
			operator: "AND" | "OR";
			left: Expression;
			right: Expression;
	  }
	| { type: "not"; expression: Expression }
	| {
			type: "comparison";
			field: string;
			operator: ComparisonOperator;
			value: LiteralValue;
	  }
	| {
			type: "macro";
			name: MacroName;
			args: string[];
	  };

type ComparisonOperator =
	| "="
	| "!="
	| "<"
	| "<="
	| ">"
	| ">="
	| "contains"
	| "=~";

export interface CompiledTaskQuery {
	query: string;
	matches(record: TaskDocumentRecord): boolean;
}

const compiledQueryCache = new Map<string, CompiledTaskQuery>();
const COMPILED_QUERY_CACHE_MAX = 100;

export function compileTaskQuery(query: string): CompiledTaskQuery {
	const normalizedQuery = query.trim();
	if (!normalizedQuery) {
		return {
			query,
			matches: () => true,
		};
	}

	const cached = compiledQueryCache.get(normalizedQuery);
	if (cached) return cached;

	const parser = new Parser(tokenize(normalizedQuery));
	const expression = parser.parse();
	const compiled = {
		query: normalizedQuery,
		matches: (record: TaskDocumentRecord) =>
			evaluateExpression(expression, record),
	};
	// Evict the oldest entry when the cache reaches its limit
	if (compiledQueryCache.size >= COMPILED_QUERY_CACHE_MAX) {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unnecessary-type-assertion
		compiledQueryCache.delete(compiledQueryCache.keys().next().value!);
	}
	compiledQueryCache.set(normalizedQuery, compiled);
	return compiled;
}

export function filterTaskRecordsByQuery(
	records: TaskDocumentRecord[],
	query: string,
): TaskDocumentRecord[] {
	const compiled = compileTaskQuery(query);
	return records.filter((record) => compiled.matches(record));
}

class Parser {
	private index = 0;

	constructor(private readonly tokens: Token[]) {}

	parse(): Expression {
		const expression = this.parseOr();
		this.expect("eof");
		return expression;
	}

	private parseOr(): Expression {
		let expression = this.parseAnd();
		while (this.matchKeyword("OR")) {
			expression = {
				type: "binary",
				operator: "OR",
				left: expression,
				right: this.parseAnd(),
			};
		}
		return expression;
	}

	private parseAnd(): Expression {
		let expression = this.parseNot();
		while (this.matchKeyword("AND")) {
			expression = {
				type: "binary",
				operator: "AND",
				left: expression,
				right: this.parseNot(),
			};
		}
		return expression;
	}

	private parseNot(): Expression {
		if (this.matchKeyword("NOT")) {
			return { type: "not", expression: this.parseNot() };
		}
		return this.parsePrimary();
	}

	private parsePrimary(): Expression {
		if (this.matchParen("(")) {
			const expression = this.parseOr();
			this.expectParen(")");
			return expression;
		}
		if (this.isMacroAhead()) {
			return this.parseMacro();
		}
		return this.parseComparison();
	}

	private isMacroAhead(): boolean {
		const token = this.current();
		if (token.type !== "identifier") return false;
		const name = token.value.toLowerCase();
		if (name !== "happens" && name !== "is" && name !== "covers") {
			return false;
		}
		const next = this.tokens[this.index + 1];
		return next?.type === "paren" && next.value === "(";
	}

	private parseMacro(): Expression {
		const nameToken = this.expect("identifier");
		const rawName = nameToken.value.toLowerCase();
		if (rawName !== "happens" && rawName !== "is" && rawName !== "covers") {
			throw this.error(nameToken, `Unknown macro '${rawName}'.`);
		}
		const name = rawName as MacroName;

		this.expectParen("(");
		const args: string[] = [];

		if (name === "happens" || name === "covers") {
			if (this.current().type === "paren" && this.current().value === ")") {
				args.push(todayString());
			} else if (
				this.current().type === "identifier" &&
				this.current().value.toLowerCase() === "date"
			) {
				args.push(this.parseDateFunction());
			} else if (this.current().type === "string") {
				const strVal = this.current().value;
				this.index++;
				args.push(resolveBaseDate(strVal));
			} else if (this.current().type === "identifier") {
				const idVal = this.current().value;
				this.index++;
				args.push(resolveBaseDate(idVal));
			} else {
				throw this.error(
					this.current(),
					`Expected date argument in ${rawName}(...).`,
				);
			}
		} else if (name === "is") {
			const argToken = this.current();
			if (argToken.type === "identifier" || argToken.type === "string") {
				this.index++;
				args.push(argToken.value.toLowerCase());
			} else {
				throw this.error(argToken, `Expected keyword in ${rawName}(...).`);
			}
		}

		this.expectParen(")");
		return { type: "macro", name, args };
	}

	private parseComparison(): Expression {
		const field = this.expect("identifier").value;
		const operator = this.parseOperator();
		const value = this.parseValue();
		return { type: "comparison", field, operator, value };
	}

	private parseOperator(): ComparisonOperator {
		const token = this.current();
		if (token.type === "operator") {
			this.index++;
			return token.value as ComparisonOperator;
		}
		if (
			token.type === "identifier" &&
			token.value.toLowerCase() === "contains"
		) {
			this.index++;
			return "contains";
		}
		throw this.error(token, "Expected an operator.");
	}

	private parseValue(): LiteralValue {
		const token = this.current();
		if (token.type === "string") {
			this.index++;
			return token.value;
		}
		if (token.type === "boolean") {
			this.index++;
			return token.value === "true";
		}
		if (token.type === "null") {
			this.index++;
			return null;
		}
		if (
			token.type === "identifier" &&
			token.value.toLowerCase() === "date"
		) {
			return this.parseDateFunction();
		}
		if (token.type === "identifier") {
			this.index++;
			return token.value;
		}
		throw this.error(token, "Expected a query value.");
	}

	private parseDateFunction(): string {
		this.expect("identifier");
		this.expectParen("(");
		const firstToken = this.current();
		let baseDate = todayString();
		let offsetStr: string | null = null;

		if (firstToken.type === "string") {
			this.index++;
			baseDate = resolveBaseDate(firstToken.value);
		} else if (firstToken.type === "identifier") {
			this.index++;
			baseDate = resolveBaseDate(firstToken.value);
		} else {
			throw this.error(
				firstToken,
				"Expected today, relative date, or date string in date(...).",
			);
		}

		if (this.current().type === "comma") {
			this.index++;
			const secondToken = this.current();
			if (secondToken.type === "string" || secondToken.type === "identifier") {
				this.index++;
				offsetStr = secondToken.value;
			} else {
				throw this.error(secondToken, "Expected offset in date(base, offset).");
			}
		} else if (this.current().value === "+" || this.current().value === "-") {
			const sign = this.current().value;
			this.index++;
			const offsetToken = this.current();
			if (offsetToken.type === "identifier" || offsetToken.type === "string") {
				this.index++;
				offsetStr = `${sign}${offsetToken.value}`;
			} else {
				throw this.error(offsetToken, "Expected offset after +/- in date(...).");
			}
		}

		if (offsetStr) {
			baseDate = applyDateOffset(baseDate, offsetStr);
		}

		this.expectParen(")");
		return baseDate;
	}

	private matchKeyword(keyword: "AND" | "OR" | "NOT"): boolean {
		const token = this.current();
		if (
			token.type !== "identifier" ||
			token.value.toUpperCase() !== keyword
		)
			return false;
		this.index++;
		return true;
	}

	private matchParen(value: "(" | ")"): boolean {
		const token = this.current();
		if (token.type !== "paren" || token.value !== value) return false;
		this.index++;
		return true;
	}

	private expectParen(value: "(" | ")"): Token {
		const token = this.current();
		if (token.type === "paren" && token.value === value) {
			this.index++;
			return token;
		}
		throw this.error(token, `Expected '${value}'.`);
	}

	private expect(type: TokenType): Token {
		const token = this.current();
		if (token.type === type) {
			this.index++;
			return token;
		}
		throw this.error(token, `Expected ${type}.`);
	}

	private current(): Token {
		return this.tokens[this.index] ?? this.tokens[this.tokens.length - 1]!;
	}

	private error(token: Token, message: string): TaskQueryError {
		return new TaskQueryError(`${message} Position ${token.position}.`);
	}
}

function evaluateExpression(
	expression: Expression,
	record: TaskDocumentRecord,
): boolean {
	switch (expression.type) {
		case "binary":
			return expression.operator === "AND"
				? evaluateExpression(expression.left, record) &&
						evaluateExpression(expression.right, record)
				: evaluateExpression(expression.left, record) ||
						evaluateExpression(expression.right, record);
		case "not":
			return !evaluateExpression(expression.expression, record);
		case "comparison":
			return evaluateComparison(
				getFieldValue(record, expression.field),
				expression.operator,
				expression.value,
			);
		case "macro":
			return evaluateMacro(expression.name, expression.args, record);
	}
}

function evaluateMacro(
	name: MacroName,
	args: string[],
	record: TaskDocumentRecord,
): boolean {
	if (name === "happens") {
		const targetDate = args[0] || todayString();
		const dates = record.task.dates;
		return (
			dates.start === targetDate ||
			dates.scheduled === targetDate ||
			dates.due === targetDate
		);
	}
	if (name === "covers") {
		const targetDate = args[0] || todayString();
		const dates = record.task.dates;
		const start = dates.start;
		const due = dates.due;
		if (!start) return false;
		if (start > targetDate) return false;
		if (due) {
			return due >= targetDate;
		}
		return record.task.status !== "DONE" && record.task.status !== "CANCELLED";
	}
	if (name === "is") {
		const state = (args[0] || "").toLowerCase();
		const status = record.task.status;
		const today = todayString();
		const isOpen = status !== "DONE" && status !== "CANCELLED";

		switch (state) {
			case "open":
				return isOpen;
			case "done":
				return status === "DONE";
			case "cancelled":
				return status === "CANCELLED";
			case "in_progress":
				return status === "IN_PROGRESS";
			case "overdue": {
				if (!isOpen) return false;
				const due = record.task.dates.due;
				return Boolean(due && due < today);
			}
			case "overdate": {
				if (!isOpen) return false;
				const scheduled = record.task.dates.scheduled;
				return Boolean(scheduled && scheduled < today);
			}
			case "blocked": {
				if (!isOpen) return false;
				return Boolean(
					record.task.dependsOn &&
						record.task.dependsOn.trim().length > 0,
				);
			}
			case "root":
				return (
					record.parentLine === null ||
					record.parentLine === undefined ||
					record.depth === 0
				);
			case "subtask":
				return (
					record.parentLine !== null &&
					record.parentLine !== undefined &&
					record.depth > 0
				);
			default:
				throw new TaskQueryError(
					`Unknown macro state '${state}' in is(...).`,
				);
		}
	}
	return false;
}

function evaluateComparison(
	left: LiteralValue | string[],
	operator: ComparisonOperator,
	right: LiteralValue,
): boolean {
	if (Array.isArray(left)) {
		const target = right === null ? "" : String(right).trim();
		if (operator === "=") {
			return left.includes(target);
		}
		if (operator === "!=") {
			return !left.includes(target);
		}
		if (operator === "contains" || operator === "=~") {
			return left.some((item) => item.includes(target));
		}
		return false;
	}
	if (operator === "contains") {
		if (left === null || right === null) return false;
		return String(left).includes(String(right));
	}
	if (operator === "=~") {
		if (left === null || right === null) return false;
		return String(left).includes(String(right));
	}
	if (operator === "=") return compareValues(left, right) === 0;
	if (operator === "!=") return compareValues(left, right) !== 0;
	if (left === null || right === null) return false;
	const comparison = compareValues(left, right);
	if (operator === "<") return comparison < 0;
	if (operator === "<=") return comparison <= 0;
	if (operator === ">") return comparison > 0;
	return comparison >= 0;
}

const PRIORITY_RANKS: Record<string, number> = {
	highest: 5,
	"🔺": 5,
	high: 4,
	"⏫": 4,
	medium: 3,
	"🔼": 3,
	low: 2,
	"🔽": 2,
	lowest: 1,
	"⏬": 1,
	none: 0,
	"": 0,
};

function compareValues(left: LiteralValue, right: LiteralValue): number {
	if (left === right) return 0;

	const leftStr = left === null ? "" : String(left).trim();
	const rightStr = right === null ? "" : String(right).trim();
	if (leftStr in PRIORITY_RANKS && rightStr in PRIORITY_RANKS) {
		return (PRIORITY_RANKS[leftStr] ?? 0) - (PRIORITY_RANKS[rightStr] ?? 0);
	}

	if (typeof left === "number" && typeof right === "number") {
		return left - right;
	}
	if (typeof left === "boolean" || typeof right === "boolean") {
		return String(left).localeCompare(String(right));
	}
	if (left === null || right === null) {
		return left === null ? -1 : 1;
	}
	return String(left).localeCompare(String(right));
}

function getFieldValue(
	record: TaskDocumentRecord,
	field: string,
): LiteralValue | string[] {
	const norm = field.toLowerCase().trim();
	switch (norm) {
		case "status":
			return record.task.status;
		case "completed":
			return record.task.status === "DONE";
		case "description":
			return record.task.description;
		case "priority":
			return record.task.priority ?? "";
		case "path":
			return record.path;
		case "basename":
			return record.basename;
		case "tags":
			return record.task.tags.join(" ");
		case "assignee":
		case "assigned":
		case "person":
			return record.task.assignee;
		case "location":
		case "place":
		case "loc":
			return record.task.location ?? "";
		case "haschildren":
			return record.hasChildren;
		case "parentline":
			return record.parentLine;
		case "linenumber":
			return record.lineNumber;
		case "depth":
			return record.depth;
		case "due":
			return record.task.dates.due;
		case "scheduled":
			return record.task.dates.scheduled;
		case "start":
			return record.task.dates.start;
		case "created":
			return record.task.dates.created;
		case "completion":
		case "done":
			return record.task.dates.done;
		case "cancelled":
			return record.task.dates.cancelled;
		case "remind":
			return record.task.dates.remind;
		case "repeat":
		case "recurrence":
			return record.task.recurrence ?? "";
		case "oncompletion":
			return record.task.onCompletion ?? "";
		case "dependson":
		case "blockedby":
			return record.task.dependsOn ?? "";
		case "id":
			return record.task.id ?? "";
		default:
			throw new TaskQueryError(`Unknown query field '${field}'.`);
	}
}

function tokenize(input: string): Token[] {
	const tokens: Token[] = [];
	let index = 0;
	while (index < input.length) {
		const char = input[index]!;
		if (/\s/u.test(char)) {
			index++;
			continue;
		}
		if (char === "(" || char === ")") {
			tokens.push({ type: "paren", value: char, position: index });
			index++;
			continue;
		}
		if (char === ",") {
			tokens.push({ type: "comma", value: char, position: index });
			index++;
			continue;
		}
		if (char === '"' || char === "'") {
			const parsed = readString(input, index, char);
			tokens.push({
				type: "string",
				value: parsed.value,
				position: index,
			});
			index = parsed.nextIndex;
			continue;
		}
		const twoChar = input.slice(index, index + 2);
		if (
			twoChar === "<=" ||
			twoChar === ">=" ||
			twoChar === "!=" ||
			twoChar === "=~"
		) {
			tokens.push({ type: "operator", value: twoChar, position: index });
			index += 2;
			continue;
		}
		if (char === "=" || char === "<" || char === ">") {
			tokens.push({ type: "operator", value: char, position: index });
			index++;
			continue;
		}
		if (char === "+") {
			if (index + 1 < input.length && /[0-9]/u.test(input[index + 1]!)) {
				const start = index;
				index++;
				while (
					index < input.length &&
					/[A-Za-z0-9_.#/-]/u.test(input[index]!)
				)
					index++;
				const value = input.slice(start, index);
				tokens.push({ type: "identifier", value, position: start });
				continue;
			}
			tokens.push({ type: "operator", value: "+", position: index });
			index++;
			continue;
		}
		if (/[A-Za-z0-9_.#/-]/u.test(char)) {
			const start = index;
			while (
				index < input.length &&
				/[A-Za-z0-9_.#/-]/u.test(input[index]!)
			)
				index++;
			const value = input.slice(start, index);
			const lowerValue = value.toLowerCase();
			const type: TokenType =
				lowerValue === "true" || lowerValue === "false"
					? "boolean"
					: lowerValue === "null"
						? "null"
						: "identifier";
			tokens.push({ type, value, position: start });
			continue;
		}
		throw new TaskQueryError(
			`Unexpected character '${char}'. Position ${index}.`,
		);
	}
	tokens.push({ type: "eof", value: "", position: input.length });
	return tokens;
}

function readString(
	input: string,
	start: number,
	quoteChar: string,
): { value: string; nextIndex: number } {
	let index = start + 1;
	let value = "";
	while (index < input.length) {
		const char = input[index]!;
		if (char === quoteChar) return { value, nextIndex: index + 1 };
		if (char === "\\") {
			const next = input[index + 1];
			if (next === undefined)
				throw new TaskQueryError(
					`Unterminated string. Position ${start}.`,
				);
			value += next;
			index += 2;
			continue;
		}
		value += char;
		index++;
	}
	throw new TaskQueryError(`Unterminated string. Position ${start}.`);
}

export function computeRelativeDate(
	base: string,
	amount: number,
	unit: "d" | "w" | "m" | "y",
): string {
	const parts = base.split("-").map(Number);
	if (
		parts.length < 3 ||
		isNaN(parts[0]!) ||
		isNaN(parts[1]!) ||
		isNaN(parts[2]!)
	) {
		return base;
	}
	const y = parts[0]!;
	const m = parts[1]! - 1;
	const d = parts[2]!;
	const dt = new Date(Date.UTC(y, m, d));
	if (unit === "d") dt.setUTCDate(dt.getUTCDate() + amount);
	else if (unit === "w") dt.setUTCDate(dt.getUTCDate() + amount * 7);
	else if (unit === "m") dt.setUTCMonth(dt.getUTCMonth() + amount);
	else if (unit === "y") dt.setUTCFullYear(dt.getUTCFullYear() + amount);
	return dt.toISOString().slice(0, 10);
}

function parseOffset(
	str: string,
): { amount: number; unit: "d" | "w" | "m" | "y" } | null {
	const match = /^([+-]?\d+)\s*([dwmy])$/i.exec(str.trim());
	if (!match) return null;
	const amount = parseInt(match[1]!, 10);
	const unit = match[2]!.toLowerCase() as "d" | "w" | "m" | "y";
	return { amount, unit };
}

function resolveBaseDate(val: string): string {
	const trimmed = val.trim();
	const lower = trimmed.toLowerCase();
	const today = todayString();
	if (lower === "today") return today;
	if (lower === "tomorrow") return computeRelativeDate(today, 1, "d");
	if (lower === "yesterday") return computeRelativeDate(today, -1, "d");
	if (lower === "next-week" || lower === "next_week")
		return computeRelativeDate(today, 7, "d");
	const offset = parseOffset(trimmed);
	if (offset) {
		return computeRelativeDate(today, offset.amount, offset.unit);
	}
	return trimmed;
}

function applyDateOffset(base: string, offsetStr: string): string {
	const offset = parseOffset(offsetStr);
	if (!offset) return base;
	return computeRelativeDate(base, offset.amount, offset.unit);
}

function todayString(): string {
	const momentFactory =
		typeof window !== "undefined" ? window.moment : undefined;
	if (momentFactory) return momentFactory().format("YYYY-MM-DD");
	return new Date().toISOString().slice(0, 10);
}
export function doesQueryExcludeCompleted(query?: string): boolean {
	if (!query || !query.trim()) return false;
	try {
		const parser = new Parser(tokenize(query.trim()));
		const expr = parser.parse();
		return exprExcludesCompleted(expr);
	} catch {
		const upper = query.toUpperCase();
		return (
			upper.includes('STATUS != "DONE"') ||
			upper.includes("STATUS != 'DONE'") ||
			upper.includes('STATUS = "TODO"') ||
			upper.includes('STATUS = "IN_PROGRESS"') ||
			upper.includes("IS(TODO)") ||
			upper.includes("NOT IS(DONE)")
		);
	}
}

function exprExcludesCompleted(expr: Expression): boolean {
	switch (expr.type) {
		case "binary":
			if (expr.operator === "AND") {
				return exprExcludesCompleted(expr.left) || exprExcludesCompleted(expr.right);
			} else if (expr.operator === "OR") {
				return exprExcludesCompleted(expr.left) && exprExcludesCompleted(expr.right);
			}
			return false;

		case "not":
			return exprRequiresCompleted(expr.expression);

		case "comparison": {
			const field = expr.field.toLowerCase();
			if (field === "status") {
				const val = typeof expr.value === "string" ? expr.value.toUpperCase() : expr.value;
				if (expr.operator === "!=" && val === "DONE") {
					return true;
				}
				if (expr.operator === "=" && val !== "DONE" && typeof val === "string") {
					return true;
				}
			}
			return false;
		}

		case "macro":
			if (expr.name === "is") {
				const arg = expr.args[0]?.toLowerCase();
				if (arg === "todo") return true;
			}
			return false;

		default:
			return false;
	}
}

function exprRequiresCompleted(expr: Expression): boolean {
	switch (expr.type) {
		case "comparison": {
			const field = expr.field.toLowerCase();
			if (field === "status") {
				const val = typeof expr.value === "string" ? expr.value.toUpperCase() : expr.value;
				if (expr.operator === "=" && val === "DONE") {
					return true;
				}
			}
			return false;
		}
		case "macro":
			if (expr.name === "is") {
				const arg = expr.args[0]?.toLowerCase();
				if (arg === "done") return true;
			}
			return false;
		case "not":
			return exprExcludesCompleted(expr.expression);
		default:
			return false;
	}
}
