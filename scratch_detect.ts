import { readFileSync } from "fs";
import { parseFrontmatterTask } from "./src/model/frontmatterTask";
import { StatusRegistry } from "./src/model/status";
import { buildTaskTree } from "./src/model/tree";

// Mock Obsidian TFile
const file = {
	path: "Academy/UMM/UMM-OPD.md",
	basename: "UMM-OPD",
	extension: "md"
} as any;

// Read user's real file
const content = readFileSync("D:/Users/sunnylin/Documents/Tasks/Academy/UMM/UMM-OPD.md", "utf8");

// Parse YAML frontmatter simply (to mock Obsidian's metadata cache parsing)
const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/u);
let frontmatter: any = null;
if (fmMatch) {
	const lines = fmMatch[1].split("\n");
	frontmatter = {};
	for (const line of lines) {
		const match = line.match(/^([a-zA-Z_0-9\-]+):\s*(.*)/u);
		if (match) {
			const key = match[1].trim();
			let val: any = match[2].trim();
			if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
			if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
			if (val === "true") val = true;
			if (val === "false") val = false;
			if (val === "null") val = null;
			frontmatter[key] = val;
		}
	}
}

const metadata = { frontmatter } as any;
const registry = new StatusRegistry();
const lines = content.split("\n");
const tree = buildTaskTree(lines, metadata, registry);
const hasBodyTasks = tree.nodes.some((n) => n.task);
const record = parseFrontmatterTask(file, metadata, registry, hasBodyTasks);

console.log("=== FRONTMATTER IN FILE ===");
console.log(frontmatter);
console.log("\n=== DETECTED FILE TASK RECORD ===");
console.log(JSON.stringify(record, null, 2));

console.log("\n=== LINE-LEVEL TASKS IN BODY ===");
tree.nodes.filter(n => n.task).forEach(n => {
	console.log(`Line ${n.lineNumber + 1}: [${n.task.symbol}] ${n.task.data.description}`);
});
