import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	PROJECT_SUPERSET_DIR_NAME,
	PROJECTS_DIR_NAME,
	SUPERSET_DIR_NAME,
} from "shared/constants";
import { runTeardown } from "./teardown";

const TEST_DIR = join(tmpdir(), `superset-test-teardown-${process.pid}`);
const MAIN_REPO = join(TEST_DIR, "main-repo");
const WORKTREE = join(TEST_DIR, "worktree");
const PROJECT_ID = "test-teardown-project";
const USER_CONFIG_DIR = join(
	homedir(),
	SUPERSET_DIR_NAME,
	PROJECTS_DIR_NAME,
	PROJECT_ID,
);
const TEST_SHELL = process.platform === "win32" ? "cmd.exe" : "/bin/sh";

let originalShell: string | undefined;

function writeProjectConfig(
	basePath: string,
	config: { setup?: string[]; teardown?: string[] },
): void {
	mkdirSync(join(basePath, PROJECT_SUPERSET_DIR_NAME), { recursive: true });
	writeFileSync(
		join(basePath, PROJECT_SUPERSET_DIR_NAME, "config.json"),
		JSON.stringify(config),
	);
}

function writeTextCommand(filePath: string, text: string): string {
	if (process.platform === "win32") {
		return `echo ${text} > "${filePath}"`;
	}
	return `echo ${text} > "${filePath}"`;
}

function fileExistsCommand(filePath: string): string {
	if (process.platform === "win32") {
		return `if exist "${filePath}" (exit /b 0) else (exit /b 1)`;
	}
	return `test -f "${filePath}"`;
}

function failCommand(): string {
	return process.platform === "win32" ? "exit /b 1" : "exit 1";
}

function writeEnvCommand(filePath: string): string {
	if (process.platform === "win32") {
		return `echo %SUPERSET_WORKSPACE_NAME%^|%SUPERSET_ROOT_PATH% > "${filePath}"`;
	}
	return `printf "%s|%s" "$SUPERSET_WORKSPACE_NAME" "$SUPERSET_ROOT_PATH" > "${filePath}"`;
}

describe("runTeardown", () => {
	beforeEach(() => {
		originalShell = process.env.SHELL;
		process.env.SHELL = TEST_SHELL;

		// Create test directories
		mkdirSync(join(MAIN_REPO, PROJECT_SUPERSET_DIR_NAME), { recursive: true });
		mkdirSync(WORKTREE, { recursive: true });
	});

	afterEach(() => {
		// Clean up
		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true, force: true });
		}
		// Clean up user override dir
		if (existsSync(USER_CONFIG_DIR)) {
			rmSync(USER_CONFIG_DIR, { recursive: true, force: true });
		}
		if (originalShell === undefined) {
			delete process.env.SHELL;
		} else {
			process.env.SHELL = originalShell;
		}
	});

	test("returns success when no config exists", async () => {
		const result = await runTeardown({
			mainRepoPath: MAIN_REPO,
			worktreePath: WORKTREE,
			workspaceName: "test-workspace",
		});
		expect(result.success).toBe(true);
		expect(result.error).toBeUndefined();
	});

	test("returns success when config has no teardown commands", async () => {
		writeProjectConfig(MAIN_REPO, { setup: ["echo setup"] });

		const result = await runTeardown({
			mainRepoPath: MAIN_REPO,
			worktreePath: WORKTREE,
			workspaceName: "test-workspace",
		});
		expect(result.success).toBe(true);
	});

	test("returns success when teardown array is empty", async () => {
		writeProjectConfig(MAIN_REPO, { teardown: [] });

		const result = await runTeardown({
			mainRepoPath: MAIN_REPO,
			worktreePath: WORKTREE,
			workspaceName: "test-workspace",
		});
		expect(result.success).toBe(true);
	});

	test("reads config from mainRepoPath and executes teardown", async () => {
		// This marker file will be created by the teardown command
		// proving the config was read from mainRepoPath
		const markerFile = join(WORKTREE, "main-repo-config-executed.txt");

		writeProjectConfig(MAIN_REPO, {
			teardown: [writeTextCommand(markerFile, "executed")],
		});

		const result = await runTeardown({
			mainRepoPath: MAIN_REPO,
			worktreePath: WORKTREE,
			workspaceName: "test-workspace",
		});

		expect(result.success).toBe(true);
		expect(existsSync(markerFile)).toBe(true);
		expect(readFileSync(markerFile, "utf-8").trim()).toBe("executed");
	});

	test("uses worktreePath config when present", async () => {
		const worktreeMarker = join(WORKTREE, "worktree-config-executed.txt");
		writeProjectConfig(WORKTREE, {
			teardown: [writeTextCommand(worktreeMarker, "executed")],
		});

		const result = await runTeardown({
			mainRepoPath: MAIN_REPO,
			worktreePath: WORKTREE,
			workspaceName: "test-workspace",
		});

		expect(result.success).toBe(true);
		expect(existsSync(worktreeMarker)).toBe(true);
		expect(readFileSync(worktreeMarker, "utf-8").trim()).toBe("executed");
	});

	test("prefers worktreePath config over mainRepoPath config", async () => {
		const mainMarker = join(WORKTREE, "from-main.txt");
		const worktreeMarker = join(WORKTREE, "from-worktree.txt");

		writeProjectConfig(MAIN_REPO, {
			teardown: [writeTextCommand(mainMarker, "main")],
		});

		writeProjectConfig(WORKTREE, {
			teardown: [writeTextCommand(worktreeMarker, "worktree")],
		});

		const result = await runTeardown({
			mainRepoPath: MAIN_REPO,
			worktreePath: WORKTREE,
			workspaceName: "test-workspace",
		});

		expect(result.success).toBe(true);
		expect(existsSync(worktreeMarker)).toBe(true);
		expect(existsSync(mainMarker)).toBe(false);
	});

	test("returns error when teardown command fails", async () => {
		writeProjectConfig(MAIN_REPO, { teardown: [failCommand()] });

		const result = await runTeardown({
			mainRepoPath: MAIN_REPO,
			worktreePath: WORKTREE,
			workspaceName: "test-workspace",
		});
		expect(result.success).toBe(false);
		expect(result.error).toBeDefined();
	});

	test("chains multiple teardown commands with &&", async () => {
		const testFile = join(WORKTREE, "teardown-test.txt");
		writeProjectConfig(MAIN_REPO, {
			teardown: [
				writeTextCommand(testFile, "created"),
				fileExistsCommand(testFile),
			],
		});

		const result = await runTeardown({
			mainRepoPath: MAIN_REPO,
			worktreePath: WORKTREE,
			workspaceName: "test-workspace",
		});
		expect(result.success).toBe(true);
		expect(existsSync(testFile)).toBe(true);
	});

	test("sets environment variables for teardown scripts", async () => {
		const envFile = join(WORKTREE, "env-test.txt");
		writeProjectConfig(MAIN_REPO, {
			teardown: [writeEnvCommand(envFile)],
		});

		const result = await runTeardown({
			mainRepoPath: MAIN_REPO,
			worktreePath: WORKTREE,
			workspaceName: "my-workspace",
		});
		expect(result.success).toBe(true);

		const content = readFileSync(envFile, "utf-8").trim();
		expect(content).toBe(`my-workspace|${MAIN_REPO}`);
	});

	test("reads from user override when projectId is provided", async () => {
		const mainMarker = join(WORKTREE, "from-main.txt");
		const userMarker = join(WORKTREE, "from-user.txt");

		writeProjectConfig(MAIN_REPO, {
			teardown: [writeTextCommand(mainMarker, "main")],
		});

		mkdirSync(USER_CONFIG_DIR, { recursive: true });
		writeFileSync(
			join(USER_CONFIG_DIR, "config.json"),
			JSON.stringify({ teardown: [writeTextCommand(userMarker, "user")] }),
		);

		const result = await runTeardown({
			mainRepoPath: MAIN_REPO,
			worktreePath: WORKTREE,
			workspaceName: "test-workspace",
			projectId: PROJECT_ID,
		});

		expect(result.success).toBe(true);
		expect(existsSync(userMarker)).toBe(true);
		expect(readFileSync(userMarker, "utf-8").trim()).toBe("user");
		expect(existsSync(mainMarker)).toBe(false);
	});

	test("falls back to mainRepoPath when no user override exists", async () => {
		const mainMarker = join(WORKTREE, "from-main.txt");

		writeProjectConfig(MAIN_REPO, {
			teardown: [writeTextCommand(mainMarker, "main")],
		});

		const result = await runTeardown({
			mainRepoPath: MAIN_REPO,
			worktreePath: WORKTREE,
			workspaceName: "test-workspace",
			projectId: PROJECT_ID,
		});

		expect(result.success).toBe(true);
		expect(existsSync(mainMarker)).toBe(true);
		expect(readFileSync(mainMarker, "utf-8").trim()).toBe("main");
	});
});
