import { describe, expect, it } from "bun:test";
import { detectTokenCutFilter, tokenCut } from "./token-cut";

describe("tokenCut", () => {
	it("compacts large git diffs while preserving file and hunk headers", () => {
		const diff = [
			"diff --git a/app.ts b/app.ts",
			"index 111..222 100644",
			"--- a/app.ts",
			"+++ b/app.ts",
			"@@ -1,200 +1,200 @@",
			...Array.from({ length: 220 }, (_, index) =>
				index % 10 === 0 ? `+changed ${index}` : ` context ${index}`,
			),
		].join("\n");

		const result = tokenCut(diff);

		expect(result.changed).toBe(true);
		expect(result.filter).toBe("git-diff");
		expect(result.text).toContain("diff --git a/app.ts b/app.ts");
		expect(result.text).toContain("@@ -1,200 +1,200 @@");
		expect(result.text.length).toBeLessThan(diff.length);
	});

	it("detects grep output and caps repeated matches per file", () => {
		const grep = Array.from(
			{ length: 80 },
			(_, index) => `src/app.ts:${index + 1}:match ${index}`,
		).join("\n");

		expect(detectTokenCutFilter(grep)).toBe("grep");

		const result = tokenCut(grep);
		expect(result.changed).toBe(true);
		expect(result.text).toContain("[token-cut omitted");
		expect(result.text.split("\n").length).toBeLessThan(
			grep.split("\n").length,
		);
	});

	it("leaves short ordinary text alone", () => {
		const result = tokenCut("normal task description");
		expect(result.changed).toBe(false);
		expect(result.text).toBe("normal task description");
	});
});
