import { describe, expect, it } from "bun:test";
import {
	BINARY_INSTALL,
	CHECKED_BINARIES,
	RUNTIME_BINARY,
} from "./agent-binaries";
import { AGENT_TYPES } from "./agent-command";

describe("agent-binaries", () => {
	it("maps every agent runtime to a binary that has install info", () => {
		for (const type of AGENT_TYPES) {
			const binary = RUNTIME_BINARY[type];
			expect(binary).toBeDefined();
			expect(BINARY_INSTALL[binary]).toBeDefined();
		}
	});

	it("gives every checked binary a copy-pasteable command and URL", () => {
		for (const binary of CHECKED_BINARIES) {
			const info = BINARY_INSTALL[binary];
			expect(info.command.length).toBeGreaterThan(0);
			expect(info.url.startsWith("https://")).toBe(true);
		}
	});
});
