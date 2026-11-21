import { describe, expect, it } from "bun:test";
import { classifyTask, slugForTask } from "./task-routing";

describe("classifyTask", () => {
	it.each([
		"Fix the typo in the README heading",
		"Rename getUser to fetchUser in src/api/users.ts",
		"Bump the version to 1.4.2",
		"Fix lint warnings in Button.tsx",
	])("sends a small, specified change to quick: %s", (task) => {
		expect(classifyTask(task).route).toBe("quick");
	});

	it.each([
		"Add a loading spinner to the save button and disable it while saving",
		"Fix the crash when the user list is empty",
		"Add an endpoint that returns the current user's settings",
	])("implements a focused change directly: %s", (task) => {
		expect(classifyTask(task).route).toBe("implement");
	});

	it.each([
		"Refactor the session store and migrate it to the new database schema",
		"Redesign the notification architecture so hooks work across all runtimes",
		"Add rate limiting to src/api/a.ts, src/api/b.ts, src/api/c.ts and src/api/d.ts",
		"Refactor how terminals are created so that apps/desktop/src/main/a.ts and packages/shared/b.ts share one path",
	])("plans complex work: %s", (task) => {
		expect(classifyTask(task).route).toBe("plan");
	});

	it("plans very long descriptions", () => {
		expect(classifyTask("word ".repeat(130)).route).toBe("plan");
	});

	it("keeps one complex word in a short task on implement", () => {
		const decision = classifyTask("Improve database error message");
		expect(decision.route).toBe("implement");
		expect(decision.reasons[0]).toContain("database");
	});

	it("does not treat a simple word inside a complex task as quick", () => {
		expect(
			classifyTask("Rename the schema migration tables and refactor the loader")
				.route,
		).toBe("plan");
	});

	it("explains every decision", () => {
		for (const task of [
			"Fix typo",
			"Add a button",
			"Refactor the auth schema",
		]) {
			expect(classifyTask(task).reasons.length).toBeGreaterThan(0);
		}
	});
});

describe("slugForTask", () => {
	it("makes a short kebab-case slug and avoids collisions", () => {
		expect(
			slugForTask("Fix the crash when the user list is empty!", new Set()),
		).toBe("fix-the-crash-when-the-user");
		expect(slugForTask("Fix typo", new Set(["fix-typo"]))).toBe("fix-typo-2");
		expect(slugForTask("Fix typo", new Set(["fix-typo", "fix-typo-2"]))).toBe(
			"fix-typo-3",
		);
		expect(slugForTask("!!!", new Set())).toBe("task");
	});
});
