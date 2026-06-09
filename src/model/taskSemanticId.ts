import pinyinlite from "pinyinlite";

/**
 * Generate a semantic ID from the task description.
 * English words are converted to lowercase and separated by hyphens.
 * Chinese characters are converted to pinyin and separated by hyphens.
 * Non-alphanumeric characters (excluding spaces/punctuation) are ignored.
 * The length of the ID is limited to the first 8 tokens to keep it clean.
 */
export function generateSemanticId(description: string): string {
	// Remove tags like #tag
	const clean = description.replace(/#[^\s!@#$%^&*(),.?":{}|<>]+/g, "").trim();

	const tokens: string[] = [];
	let currentWord = "";

	for (let i = 0; i < clean.length; i++) {
		const char = clean[i]!;
		// Check if CJK character
		if (/[\u4e00-\u9fa5]/.test(char)) {
			// Flush current English word if any
			if (currentWord) {
				tokens.push(currentWord.toLowerCase());
				currentWord = "";
			}
			const pinyins = pinyinlite(char);
			if (pinyins && pinyins[0] && pinyins[0].length > 0) {
				const firstPinyin = pinyins[0][0];
				if (firstPinyin) {
					tokens.push(firstPinyin.toLowerCase());
				}
			}
		} else if (/[a-zA-Z0-9]/.test(char)) {
			currentWord += char;
		} else {
			// separator
			if (currentWord) {
				tokens.push(currentWord.toLowerCase());
				currentWord = "";
			}
		}
	}
	if (currentWord) {
		tokens.push(currentWord.toLowerCase());
	}

	// Filter out empty tokens and limit to 15 tokens
	const filtered = tokens.filter(Boolean).slice(0, 15);

	// If no tokens generated (e.g. description is empty or only special chars), return a generic unique ID
	if (filtered.length === 0) {
		return "task-" + Math.random().toString(36).substring(2, 8);
	}

	return filtered.join("-");
}
export default generateSemanticId;
