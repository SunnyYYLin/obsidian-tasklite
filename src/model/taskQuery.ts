import type { TaskDocumentRecord } from "./taskDocumentStore";

export class TaskQueryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TaskQueryError";
	}
}

type TokenType = "identifier" | "string" | "boolean" | "null" | "operator" | "paren" | "comma" | "eof";

interface Token {
	type: TokenType;
	value: string;
	position: number;
}

type LiteralValue = string | number | boolean | null;

type Expression =
	| {type: "binary"; operator: "AND" | "OR"; left: Expression; right: Expression}
	| {type: "not"; expression: Expression}
	| {type: "comparison"; field: string; operator: ComparisonOperator; value: LiteralValue};

type ComparisonOperator = "=" | "!=" | "<" | "<=" | ">" | ">=" | "contains" | "=~";

export interface CompiledTaskQuery {
	query: string;
	matches(record: TaskDocumentRecord): boolean;
}

const compiledQueryCache = new Map<string, CompiledTaskQuery>();

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
		matches: (record: TaskDocumentRecord) => evaluateExpression(expression, record),
	};
	compiledQueryCache.set(normalizedQuery, compiled);
	return compiled;
}

export function filterTaskRecordsByQuery(records: TaskDocumentRecord[], query: string): TaskDocumentRecord[] {
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
			expression = {type: "binary", operator: "OR", left: expression, right: this.parseAnd()};
		}
		return expression;
	}

	private parseAnd(): Expression {
		let expression = this.parseNot();
		while (this.matchKeyword("AND")) {
			expression = {type: "binary", operator: "AND", left: expression, right: this.parseNot()};
		}
		return expression;
	}

	private parseNot(): Expression {
		if (this.matchKeyword("NOT")) {
			return {type: "not", expression: this.parseNot()};
		}
		return this.parsePrimary();
	}

	private parsePrimary(): Expression {
		if (this.matchParen("(")) {
			const expression = this.parseOr();
			this.expectParen(")");
			return expression;
		}
		return this.parseComparison();
	}

	private parseComparison(): Expression {
		const field = this.expect("identifier").value;
		const operator = this.parseOperator();
		const value = this.parseValue();
		return {type: "comparison", field, operator, value};
	}

	private parseOperator(): ComparisonOperator {
		const token = this.current();
		if (token.type === "operator") {
			this.index++;
			return token.value as ComparisonOperator;
		}
		if (token.type === "identifier" && token.value.toLowerCase() === "contains") {
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
		if (token.type === "identifier" && token.value.toLowerCase() === "date") {
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
		const valueToken = this.current();
		let value: string;
		if (valueToken.type === "identifier" && valueToken.value.toLowerCase() === "today") {
			this.index++;
			value = todayString();
		} else if (valueToken.type === "string") {
			this.index++;
			value = valueToken.value;
		} else {
			throw this.error(valueToken, "Expected today or a date string in date(...).");
		}
		this.expectParen(")");
		return value;
	}

	private matchKeyword(keyword: "AND" | "OR" | "NOT"): boolean {
		const token = this.current();
		if (token.type !== "identifier" || token.value.toUpperCase() !== keyword) return false;
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

function evaluateExpression(expression: Expression, record: TaskDocumentRecord): boolean {
	switch (expression.type) {
		case "binary":
			return expression.operator === "AND"
				? evaluateExpression(expression.left, record) && evaluateExpression(expression.right, record)
				: evaluateExpression(expression.left, record) || evaluateExpression(expression.right, record);
		case "not":
			return !evaluateExpression(expression.expression, record);
		case "comparison":
			return evaluateComparison(getFieldValue(record, expression.field), expression.operator, expression.value);
	}
}

function evaluateComparison(left: LiteralValue, operator: ComparisonOperator, right: LiteralValue): boolean {
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

function compareValues(left: LiteralValue, right: LiteralValue): number {
	if (left === right) return 0;
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

function getFieldValue(record: TaskDocumentRecord, field: string): LiteralValue {
	switch (field) {
		case "status":
			return record.task.status;
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
		case "person":
			return record.task.person ?? "";
		case "hasChildren":
			return record.hasChildren;
		case "parentLine":
			return record.parentLine;
		case "lineNumber":
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
		case "done":
			return record.task.dates.done;
		case "cancelled":
			return record.task.dates.cancelled;
		case "recurrence":
			return record.task.recurrence ?? "";
		case "onCompletion":
			return record.task.onCompletion ?? "";
		case "dependsOn":
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
			tokens.push({type: "paren", value: char, position: index});
			index++;
			continue;
		}
		if (char === ",") {
			tokens.push({type: "comma", value: char, position: index});
			index++;
			continue;
		}
		if (char === "\"") {
			const parsed = readString(input, index);
			tokens.push({type: "string", value: parsed.value, position: index});
			index = parsed.nextIndex;
			continue;
		}
		const twoChar = input.slice(index, index + 2);
		if (twoChar === "<=" || twoChar === ">=" || twoChar === "!=" || twoChar === "=~") {
			tokens.push({type: "operator", value: twoChar, position: index});
			index += 2;
			continue;
		}
		if (char === "=" || char === "<" || char === ">") {
			tokens.push({type: "operator", value: char, position: index});
			index++;
			continue;
		}
		if (/[A-Za-z0-9_.#/-]/u.test(char)) {
			const start = index;
			while (index < input.length && /[A-Za-z0-9_.#/-]/u.test(input[index]!)) index++;
			const value = input.slice(start, index);
			const lowerValue = value.toLowerCase();
			const type: TokenType = lowerValue === "true" || lowerValue === "false"
				? "boolean"
				: lowerValue === "null"
					? "null"
					: "identifier";
			tokens.push({type, value, position: start});
			continue;
		}
		throw new TaskQueryError(`Unexpected character '${char}'. Position ${index}.`);
	}
	tokens.push({type: "eof", value: "", position: input.length});
	return tokens;
}

function readString(input: string, start: number): {value: string; nextIndex: number} {
	let index = start + 1;
	let value = "";
	while (index < input.length) {
		const char = input[index]!;
		if (char === "\"") return {value, nextIndex: index + 1};
		if (char === "\\") {
			const next = input[index + 1];
			if (next === undefined) throw new TaskQueryError(`Unterminated string. Position ${start}.`);
			value += next;
			index += 2;
			continue;
		}
		value += char;
		index++;
	}
	throw new TaskQueryError(`Unterminated string. Position ${start}.`);
}

function todayString(): string {
	const momentFactory = typeof window !== "undefined" ? window.moment : undefined;
	if (momentFactory) return momentFactory().format("YYYY-MM-DD");
	return new Date().toISOString().slice(0, 10);
}
