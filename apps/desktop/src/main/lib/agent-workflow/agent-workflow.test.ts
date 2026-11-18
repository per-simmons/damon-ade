import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
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
	upgradeAgentWorkflow,
	WORKFLOW_BRIDGE_MARKER,
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

describe("upgradeAgentWorkflow (agents created before the workflow)", () => {
	let worktree: string;
	const count = (text: string, sub: string) => text.split(sub).length - 1;
	const read = (...parts: string[]) =>
		readFileSync(join(worktree, ...parts), "utf8");

	// The files an agent scaffolded before M1 has.
	const OLD_CLAUDE_MD =
		"@/home/agent/memory/AGENT.md\n@/home/agent/memory/USER.md\n";
	const OLD_SETTINGS = {
		autoMemoryDirectory: "/home/agent/memory",
		autoMemoryEnabled: true,
		hooks: { Stop: [{ matcher: "*", hooks: [] }] },
	};
	const OLD_EXCLUDE =
		"# git ls-files --others --exclude-from=.git/info/exclude\n\n# ADE agent bridge files (generated, not committed)\nCLAUDE.md\n.claude/\nAGENTS.md\n";

	beforeEach(() => {
		worktree = mkdtempSync(join(tmpdir(), "ade-workflow-upgrade-"));
		mkdirSync(join(worktree, ".git", "info"), { recursive: true });
		mkdirSync(join(worktree, ".claude"), { recursive: true });
		writeFileSync(join(worktree, "CLAUDE.md"), OLD_CLAUDE_MD, "utf8");
		writeFileSync(
			join(worktree, ".claude", "settings.json"),
			`${JSON.stringify(OLD_SETTINGS, null, 2)}\n`,
			"utf8",
		);
		writeFileSync(
			join(worktree, ".git", "info", "exclude"),
			OLD_EXCLUDE,
			"utf8",
		);
	});

	afterEach(() => {
		rmSync(worktree, { recursive: true, force: true });
	});

	it("adds the workflow files, model, pointer and exclude", () => {
		const changes = upgradeAgentWorkflow(worktree);

		expect(changes).toContain(join(".claude", "agents", "planner.md"));
		expect(changes).toContain(join(".claude", "settings.json"));
		expect(changes).toContain("CLAUDE.md");
		expect(changes).toContain(join(".git", "info", "exclude"));

		const settings = JSON.parse(read(".claude", "settings.json"));
		expect(settings).toEqual({ model: "sonnet", ...OLD_SETTINGS });

		const claudeMd = read("CLAUDE.md");
		expect(claudeMd.startsWith(OLD_CLAUDE_MD)).toBe(true);
		expect(count(claudeMd, WORKFLOW_BRIDGE_MARKER)).toBe(1);

		const exclude = read(".git", "info", "exclude");
		expect(exclude.startsWith(OLD_EXCLUDE)).toBe(true);
		expect(exclude.split("\n")).toContain(".ade/");
	});

	it("is idempotent: a second run changes nothing", () => {
		upgradeAgentWorkflow(worktree);
		const snapshot = {
			claudeMd: read("CLAUDE.md"),
			settings: read(".claude", "settings.json"),
			exclude: read(".git", "info", "exclude"),
		};

		expect(upgradeAgentWorkflow(worktree)).toEqual([]);
		expect(read("CLAUDE.md")).toBe(snapshot.claudeMd);
		expect(read(".claude", "settings.json")).toBe(snapshot.settings);
		expect(read(".git", "info", "exclude")).toBe(snapshot.exclude);
	});

	it("keeps a model the user already chose", () => {
		const chosen = { ...OLD_SETTINGS, model: "opus" };
		const text = `${JSON.stringify(chosen, null, 2)}\n`;
		writeFileSync(join(worktree, ".claude", "settings.json"), text, "utf8");

		expect(upgradeAgentWorkflow(worktree)).not.toContain(
			join(".claude", "settings.json"),
		);
		expect(read(".claude", "settings.json")).toBe(text);
	});

	it("leaves invalid settings JSON untouched", () => {
		const broken = "{ not json";
		writeFileSync(join(worktree, ".claude", "settings.json"), broken, "utf8");

		upgradeAgentWorkflow(worktree);
		expect(read(".claude", "settings.json")).toBe(broken);
	});

	it("appends the pointer on its own line when CLAUDE.md has no trailing newline", () => {
		writeFileSync(join(worktree, "CLAUDE.md"), "# My notes", "utf8");

		upgradeAgentWorkflow(worktree);
		const claudeMd = read("CLAUDE.md");
		expect(claudeMd.startsWith("# My notes\n")).toBe(true);
		expect(claudeMd).toContain(`\n${WORKFLOW_BRIDGE_MARKER}\n`);
	});

	it("does not create CLAUDE.md or settings.json that are missing", () => {
		rmSync(join(worktree, "CLAUDE.md"));
		rmSync(join(worktree, ".claude", "settings.json"));

		upgradeAgentWorkflow(worktree);
		expect(existsSync(join(worktree, "CLAUDE.md"))).toBe(false);
		expect(existsSync(join(worktree, ".claude", "settings.json"))).toBe(false);
	});

	it("does not add a second .ade/ line when one is already excluded", () => {
		const withAde = `${OLD_EXCLUDE}.ade/\n`;
		writeFileSync(join(worktree, ".git", "info", "exclude"), withAde, "utf8");

		upgradeAgentWorkflow(worktree);
		expect(read(".git", "info", "exclude")).toBe(withAde);
	});

	it("skips the exclude when .git is a file (a linked git worktree)", () => {
		rmSync(join(worktree, ".git"), { recursive: true, force: true });
		writeFileSync(join(worktree, ".git"), "gitdir: /elsewhere\n", "utf8");

		expect(upgradeAgentWorkflow(worktree)).not.toContain(
			join(".git", "info", "exclude"),
		);
		expect(read(".git")).toBe("gitdir: /elsewhere\n");
	});
});
