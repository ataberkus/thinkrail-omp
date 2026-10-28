import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendMcpServerLog, formatMcpLogMessage, mcpServerLogLines } from "./log";

const LOG = [
	"2026-10-08T09:00:00.000Z [docs] info starting",
	"2026-10-08T09:00:01.000Z [docs-two] warning other server",
	"2026-10-08T09:00:02.000Z [docs] error fetch: failed",
	"    at connect (index.js:1)",
	"    ",
	"2026-10-08T09:00:03.000Z [other] info [docs] mentioned by another server",
	"    continuation of other",
	"stray line from a torn write",
	"    stray continuation",
	"",
].join("\n");

test("a server's log keeps its own entries and their continuation lines, never another server's", () => {
	expect(mcpServerLogLines(LOG, "docs")).toEqual([
		"2026-10-08T09:00:00.000Z [docs] info starting",
		"2026-10-08T09:00:02.000Z [docs] error fetch: failed",
		"    at connect (index.js:1)",
		"    ",
	]);
	expect(mcpServerLogLines(LOG, "docs-two")).toEqual([
		"2026-10-08T09:00:01.000Z [docs-two] warning other server",
	]);
	expect(mcpServerLogLines(LOG, "missing")).toEqual([]);
	expect(mcpServerLogLines("", "docs")).toEqual([]);
});

test("the parser reads the host's own log format, multi-line messages and rotation included", () => {
	const at = new Date("2026-10-08T09:00:00.000Z");
	const text = [
		formatMcpLogMessage("docs", { level: "error", logger: "net", data: "down\nretrying" }, at),
		formatMcpLogMessage("other", { data: { ok: true } }, at),
		formatMcpLogMessage("docs", "plain", at),
		formatMcpLogMessage("docs.v2: eu", "dotted", at),
	].join("");
	expect(mcpServerLogLines(text, "docs")).toEqual([
		"2026-10-08T09:00:00.000Z [docs] error net: down",
		"    retrying",
		"2026-10-08T09:00:00.000Z [docs] info plain",
	]);
	expect(mcpServerLogLines(text, "docs.v2: eu")).toEqual([
		"2026-10-08T09:00:00.000Z [docs.v2: eu] info dotted",
	]);
	const dir = mkdtempSync(join(tmpdir(), "mcp-log-"));
	try {
		const path = join(dir, "mcp.log");
		writeFileSync(path, "x".repeat(5 * 1024 * 1024 + 1));
		appendMcpServerLog("docs", { level: "warning", data: "rotated" }, path);
		expect(readFileSync(`${path}.1`, "utf8")).toHaveLength(5 * 1024 * 1024 + 1);
		expect(mcpServerLogLines(readFileSync(path, "utf8"), "docs")).toEqual([
			expect.stringMatching(/\[docs\] warning rotated$/),
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("only the latest lines are kept", () => {
	const many = Array.from(
		{ length: 5 },
		(_, index) => `2026-10-08T09:00:0${index}.000Z [docs] info line ${index}`,
	).join("\n");
	expect(mcpServerLogLines(many, "docs", 2)).toEqual([
		"2026-10-08T09:00:03.000Z [docs] info line 3",
		"2026-10-08T09:00:04.000Z [docs] info line 4",
	]);
});
