export function normalizeAssignees(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const assignees = value
		.filter((name): name is string => typeof name === "string")
		.map((name) => name.trim())
		.filter((name) => name.length > 0)
		.filter((name) => !/\s+-\s+/.test(name));
	return Array.from(new Set(assignees)).sort();
}
