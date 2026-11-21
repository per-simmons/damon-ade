import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as realOs from "node:os";
import path from "node:path";

const TEST_ROOT = path.join(
	realOs.tmpdir(),
	`superset-agent-wrappers-${process.pid}-${Date.now()}`,
);
const TEST_BIN_DIR = path.join(TEST_ROOT, "superset", "bin");
const TEST_HOOKS_DIR = path.join(TEST_ROOT, "superset", "hooks");
const TEST_ZSH_DIR = path.join(TEST_ROOT, "superset", "zsh");
const TEST_BASH_DIR = path.join(TEST_ROOT, "superset", "bash");
let mockedHomeDir = path.join(TEST_ROOT, "home");

mock.module("shared/env.shared", () => ({
	env: {
		DESKTOP_NOTIFICATIONS_PORT: 7777,
	},
	getWorkspaceName: () => undefined,
}));

mock.module("./notify-hook", () => ({
	NOTIFY_SCRIPT_NAME: "notify.sh",
	NOTIFY_SCRIPT_MARKER: "# Superset agent notification hook",
	getNotifyScriptPath: () => path.join(TEST_HOOKS_DIR, "notify.sh"),
	getNotifyScriptContent: () => "#!/bin/bash\nexit 0\n",
	createNotifyScript: () => {},
}));

mock.module("./paths", () => ({
	BIN_DIR: TEST_BIN_DIR,
	HOOKS_DIR: TEST_HOOKS_DIR,
	ZSH_DIR: TEST_ZSH_DIR,
	BASH_DIR: TEST_BASH_DIR,
}));

mock.module("node:os", () => ({
	...realOs,
	homedir: () => mockedHomeDir,
	default: {
		...realOs,
		homedir: () => mockedHomeDir,
	},
}));

const {
	buildCodexWrapperExecLine,
	createCodexWrapper,
	createMastraWrapper,
	getMastraHooksJsonContent,
} = await import("./agent-wrappers");

describe("agent-wrappers", () => {
	beforeEach(() => {
		mockedHomeDir = path.join(TEST_ROOT, "home");
		mkdirSync(TEST_BIN_DIR, { recursive: true });
		mkdirSync(TEST_HOOKS_DIR, { recursive: true });
	});

	afterEach(() => {
		rmSync(TEST_ROOT, { recursive: true, force: true });
	});

	it("injects codex message-start watcher + completion notifications in wrapper", () => {
		createCodexWrapper();

		const wrapperPath = path.join(TEST_BIN_DIR, "codex");
		const wrapper = readFileSync(wrapperPath, "utf-8");

		expect(wrapper).toContain("export CODEX_TUI_RECORD_SESSION=1");
		expect(wrapper).toContain('"type":"task_started"');
		expect(wrapper).toContain('_superset_last_turn_id=""');
		expect(wrapper).toContain("_superset_turn_id=$(printf");
		expect(wrapper).toContain('awk -F\'"turn_id":"\'');
		expect(wrapper).toContain('{"hook_event_name":"Start"}');
		expect(wrapper).toContain(
			`"$REAL_BIN" -c 'notify=["bash","${path.join(TEST_HOOKS_DIR, "notify.sh")}"]' "$@"`,
		);
		expect(wrapper).toContain("SUPERSET_CODEX_START_WATCHER_PID");
		expect(wrapper).toContain('kill "$SUPERSET_CODEX_START_WATCHER_PID"');

		const execLine = buildCodexWrapperExecLine(
			path.join(TEST_HOOKS_DIR, "notify.sh"),
		);
		expect(execLine).not.toContain("{{NOTIFY_PATH}}");
		expect(wrapper).toContain(execLine);
	});

	it("creates mastracode wrapper passthrough", () => {
		createMastraWrapper();

		const wrapperPath = path.join(TEST_BIN_DIR, "mastracode");
		const wrapper = readFileSync(wrapperPath, "utf-8");

		expect(wrapper).toContain("# Superset wrapper for mastracode");
		expect(wrapper).toContain('REAL_BIN="$(find_real_binary "mastracode")"');
		expect(wrapper).toContain('exec "$REAL_BIN" "$@"');
	});

	it("replaces stale Mastra hook commands from old superset paths", () => {
		const mastraHooksPath = path.join(
			mockedHomeDir,
			".mastracode",
			"hooks.json",
		);
		const staleHookPath = "/tmp/.superset-old/hooks/notify.sh";
		const currentHookPath = "/tmp/.superset-new/hooks/notify.sh";

		mkdirSync(path.dirname(mastraHooksPath), { recursive: true });
		writeFileSync(
			mastraHooksPath,
			JSON.stringify(
				{
					UserPromptSubmit: [
						{ type: "command", command: `bash '${staleHookPath}'` },
						{ type: "command", command: "/usr/local/bin/custom-hook" },
					],
					Stop: [{ type: "command", command: `bash '${staleHookPath}'` }],
					PostToolUse: [
						{ type: "command", command: `bash '${staleHookPath}'` },
					],
				},
				null,
				2,
			),
		);

		const content = getMastraHooksJsonContent(currentHookPath);
		writeFileSync(mastraHooksPath, content);
		const content2 = getMastraHooksJsonContent(currentHookPath);

		const parsed = JSON.parse(content) as Record<
			string,
			Array<{ type: string; command: string }>
		>;
		const managedEvents = ["UserPromptSubmit", "Stop", "PostToolUse"] as const;

		for (const eventName of managedEvents) {
			const hooks = parsed[eventName];
			expect(Array.isArray(hooks)).toBe(true);
			expect(
				hooks.some(
					(entry) =>
						entry.type === "command" &&
						entry.command === `bash '${currentHookPath}'`,
				),
			).toBe(true);
			expect(hooks.some((entry) => entry.command.includes(staleHookPath))).toBe(
				false,
			);
		}

		expect(
			parsed.UserPromptSubmit.some(
				(entry) => entry.command === "/usr/local/bin/custom-hook",
			),
		).toBe(true);
		expect(JSON.parse(content2)).toEqual(JSON.parse(content));
	});
});
