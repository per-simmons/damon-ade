import { describe, expect, it } from "bun:test";
import { BINARY_INSTALL } from "@superset/shared/agent-binaries";
import { buildWrapperScript } from "./agent-wrappers-common";

/**
 * The wrapper's missing-binary branch is what a user sees in the terminal when
 * an agent CLI isn't installed, so it must name the exact install command + URL
 * (kept in sync with the not-detected UI dialogs via BINARY_INSTALL).
 */
describe("missing-binary message", () => {
	it("embeds the install command and URL for a known binary", () => {
		const script = buildWrapperScript("claude", 'exec "$REAL_BIN" "$@"');
		const { command, url, label } = BINARY_INSTALL.claude;
		expect(script).toContain(command);
		expect(script).toContain(url);
		expect(script).toContain(label);
		// Stays on one line inside the bash double-quoted echo.
		expect(script).not.toContain('"claude not found');
	});

	it("covers codex too", () => {
		expect(buildWrapperScript("codex", "true")).toContain(
			BINARY_INSTALL.codex.command,
		);
	});

	it("falls back to a generic message for an unknown binary", () => {
		const script = buildWrapperScript("mysterytool", "true");
		expect(script).toContain("mysterytool not found in PATH");
	});
});
