export function normalizeAssignees(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const assignees = value
		.filter((name): name is string => typeof name === "string")
		.map((name) => name.trim())
		.filter((name) => name.length > 0)
		.filter((name) => !isStaleHyphenAssignee(name));
	return Array.from(new Set(assignees)).sort();
}

function isStaleHyphenAssignee(name: string): boolean {
	if (/\s+-\s+/.test(name)) return true;
	const duplicateMatch = name.match(/^(.+)-\1$/u);
	return duplicateMatch !== null;
}
