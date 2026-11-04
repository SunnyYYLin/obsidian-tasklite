import * as pinyinliteModule from "pinyinlite/index_full.js";
import { parseCanonicalDateTime } from "./format";

type PinyinLiteFunction = (input: string) => string[][];

interface PinyinLiteModuleShape {
	default?: PinyinLiteFunction;
}

const rawModule = pinyinliteModule as unknown as PinyinLiteModuleShape | PinyinLiteFunction;
const pinyinliteFn =
	typeof rawModule === "function" ? rawModule : rawModule.default;
const pinyinlite: PinyinLiteFunction | null =
	typeof pinyinliteFn === "function" ? pinyinliteFn : null;

function getCurrentDateStr(): string {
	const momentFactory =
		typeof window !== "undefined" ? window.moment : undefined;
	if (momentFactory) {
		return momentFactory().format("YYYY-MM-DD");
	}
	return new Date().toISOString().split("T")[0]!;
}

function generateRandom8(): string {
	let str = "";
	while (str.length < 8) {
		str += Math.random().toString(36).substring(2);
	}
	return str.substring(0, 8);
}

function generateRandom4(): string {
	let str = "";
	while (str.length < 4) {
		str += Math.random().toString(36).substring(2);
	}
	return str.substring(0, 4);
}

/**
 * Generate a semantic ID from the task description.
 * English words are converted to lowercase and separated by hyphens.
 * Chinese characters are converted to pinyin and separated by hyphens.
 * Non-alphanumeric characters (excluding spaces/punctuation) are ignored.
 * The length of the base ID is limited to 8 characters.
 * Recurring tasks get a date suffix.
 * Duplicates in the vault get a random 4-character suffix.
 */
export function generateSemanticId(
	description: string,
	options?: {
		isRecurring?: boolean;
		dueDate?: string | null;
		existingIds?: Set<string>;
	}
): string {
	// Remove tags like #tag
	const clean = description.replace(/#[^\s!@#$%^&*(),.?":{}|<>]+/g, "").trim();

	const tokens: string[] = [];
	let currentWord = "";

	for (let i = 0; i < clean.length; i++) {
		const char = clean[i]!;
		// Check if CJK character
		if (pinyinlite && /[\u4e00-\u9fa5]/.test(char)) {
			// Flush current English word if any
			if (currentWord) {
				tokens.push(currentWord[0]!.toLowerCase());
				currentWord = "";
			}
			const pinyins = pinyinlite(char);
			if (pinyins && pinyins[0] && pinyins[0].length > 0) {
				const firstPinyin = pinyins[0][0];
				if (firstPinyin && firstPinyin[0]) {
					tokens.push(firstPinyin[0].toLowerCase());
				}
			}
		} else if (/[a-zA-Z0-9]/.test(char)) {
			currentWord += char;
		} else {
			// separator
			if (currentWord) {
				tokens.push(currentWord[0]!.toLowerCase());
				currentWord = "";
			}
		}
	}
	if (currentWord) {
		tokens.push(currentWord[0]!.toLowerCase());
	}

	// Filter out empty tokens
	const filtered = tokens.filter(Boolean);

	let base = "";
	if (filtered.length > 0) {
		const fullBase = filtered.join("");
		base = fullBase.slice(0, 8);
	}

	if (!base) {
		base = generateRandom8();
	}

	if (options?.isRecurring) {
		const rawDue = options.dueDate;
		const dateSuffix = rawDue
			? (parseCanonicalDateTime(rawDue)?.date ?? rawDue.trim().split(/[ T]/)[0]!)
			: getCurrentDateStr();
		base = `${base}-${dateSuffix}`;
	}

	let finalId = base;
	if (options?.existingIds) {
		let attempts = 0;
		while (options.existingIds.has(finalId) && attempts < 1000) {
			attempts++;
			finalId = `${base}-${generateRandom4()}`;
		}
	}

	return finalId;
}

export default generateSemanticId;

