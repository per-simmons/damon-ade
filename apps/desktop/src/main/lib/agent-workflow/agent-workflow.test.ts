import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	renderCommand,
	renderSubagent,
	WORKFLOW_COMMANDS,
	WORKFLOW_SUBAGENTS,
	writeAgentWorkflowFiles,
} from "./agent-workflow";

/** Minimal frontmatter reader: `key: value` lines between the first two `---`. */
function frontmatter(content: string): Record<string, string> {
	const match = content.match(/^---\n([\s\S]*?)\n---\n/);
	if (!match) throw new Error("no frontmatter");
	const fields: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const idx = line.indexOf(": ");
		if (idx === -1) throw new Error(`bad frontmatter line: ${line}`);
		const key = line.slice(0, idx);
		const raw = line.slice(idx + 2);
		// Quoted values are JSON strings (valid YAML double-quoted scalars).
		fields[key] = raw.startsWith('"') ? JSON.parse(raw) : raw;
	}
	return fields;
}

describe("workflow subagents", () => {
	const expected: Record<
		string,
		{ model: string; effort: string; maxTurns: string; tools?: string }
	> = {
		planner: {
			model: "fable",
			effort: "high",
			maxTurns: "30",
			tools: "Read, Grep, Glob, Bash, Write",
		},
		architect: {
			model: "fable",
			effort: "high",
			maxTurns: "20",
			tools: "Read, Grep, Glob, Bash, Write, Edit",
		},
		implementer: { model: "sonnet", effort: "medium", maxTurns: "40" },
		quick: { model: "haiku", effort: "low", maxTurns: "15" },
		reviewer: {
			model: "sonnet",
			effort: "medium",
			maxTurns: "25",
			tools: "Read, Grep, Glob, Bash",
		},
	};

	it("defines exactly the planned roles", () => {
		expect(WORKFLOW_SUBAGENTS.map((a) => a.name).sort()).toEqual(
			Object.keys(expected).sort(),
		);
	});

	for (const agent of WORKFLOW_SUBAGENTS) {
		it(`renders ${agent.name} with its model, effort, turn limit and tools`, () => {
			const fields = frontmatter(renderSubagent(agent));
			const want = expected[agent.name];
			expect(fields.name).toBe(agent.name);
			expect(fields.description).toBe(agent.description);
			expect(fields.model).toBe(want.model);
			expect(fields.effort).toBe(want.effort);
			expect(fields.maxTurns).toBe(want.maxTurns);
			// No `tools` line means the role gets every tool.
			expect(fields.tools as string | undefined).toEqual(want.tools);
		});
	}

	it("keeps the reviewer read-only", () => {
		const reviewer = WORKFLOW_SUBAGENTS.find((a) => a.name === "reviewer");
		expect(reviewer?.tools).not.toContain("Write");
		expect(reviewer?.tools).not.toContain("Edit");
	});

	it("gives the coding roles the escalation rule", () => {
		const implementer = WORKFLOW_SUBAGENTS.find(
			(a) => a.name === "implementer",
		);
		expect(implementer?.prompt).toContain("escalations/NNN.md");
		expect(implementer?.prompt).toContain("two fixes");
	});
});

describe("workflow commands", () => {
	it("defines /plan, /build, /review and /escalate", () => {
		expect(WORKFLOW_COMMANDS.map((c) => c.name).sort()).toEqual([
			"build",
			"escalate",
			"plan",
			"review",
		]);
	});

	for (const command of WORKFLOW_COMMANDS) {
		it(`renders /${command.name} with parseable frontmatter and the arguments placeholder`, () => {
			const content = renderCommand(command);
			const fields = frontmatter(content);
			expect(fields.description).toBe(command.description);
			// "[slug]" must stay a string, not become a YAML list.
			expect(fields["argument-hint"]).toBe(command.argumentHint);
			expect(content).toContain("$ARGUMENTS");
		});
	}

	it("caps escalations and failed reviews instead of looping", () => {
		const build = WORKFLOW_COMMANDS.find((c) => c.name === "build");
		const review = WORKFLOW_COMMANDS.find((c) => c.name === "review");
		const escalate = WORKFLOW_COMMANDS.find((c) => c.name === "escalate");
		expect(build?.body).toContain("at most 2 escalations per step");
		expect(review?.body).toContain("After 2 failed reviews");
		expect(escalate?.body).toContain("If it is already 2");
	});
});

describe("writeAgentWorkflowFiles", () => {
	let worktree: string;

	beforeEach(() => {
		worktree = mkdtempSync(join(tmpdir(), "ade-workflow-test-"));
	});

	afterEach(() => {
		rmSync(worktree, { recursive: true, force: true });
	});

	it("writes every subagent and command into .claude/", () => {
		const written = writeAgentWorkflowFiles(worktree);
		expect(written).toHaveLength(
			WORKFLOW_SUBAGENTS.length + WORKFLOW_COMMANDS.length,
		);
		for (const agent of WORKFLOW_SUBAGENTS) {
			const path = join(worktree, ".claude", "agents", `${agent.name}.md`);
			expect(readFileSync(path, "utf8")).toBe(renderSubagent(agent));
		}
		for (const command of WORKFLOW_COMMANDS) {
			const path = join(worktree, ".claude", "commands", `${command.name}.md`);
			expect(existsSync(path)).toBe(true);
		}
	});

	it("never overwrites a file the user edited, and a rerun writes nothing", () => {
		writeAgentWorkflowFiles(worktree);
		const implementerPath = join(
			worktree,
			".claude",
			"agents",
			"implementer.md",
		);
		const edited = "---\nname: implementer\nmodel: opus\n---\nMine.\n";
		writeFileSync(implementerPath, edited, "utf8");

		expect(writeAgentWorkflowFiles(worktree)).toEqual([]);
		expect(readFileSync(implementerPath, "utf8")).toBe(edited);
	});

	it("refills a file that exists but is empty", () => {
		writeAgentWorkflowFiles(worktree);
		const quickPath = join(worktree, ".claude", "agents", "quick.md");
		writeFileSync(quickPath, "  \n", "utf8");

		expect(writeAgentWorkflowFiles(worktree)).toEqual([
			join(".claude", "agents", "quick.md"),
		]);
		expect(readFileSync(quickPath, "utf8")).toContain("model: haiku");
	});
});
