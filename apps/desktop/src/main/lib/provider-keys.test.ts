import { beforeEach, describe, expect, it, mock } from "bun:test";

// In-memory stand-ins for electron safeStorage and the local sqlite settings row.
// safeStorage is unavailable in a headless test runner, so we mock it; the toggle
// lets us exercise the graceful "encryption unavailable" path too.
let encryptionAvailable = true;
let settingsRow: { providerApiKeys?: Record<string, string> } | null = null;

mock.module("electron", () => ({
	safeStorage: {
		isEncryptionAvailable: () => encryptionAvailable,
		// Reversible, deterministic stand-in for OS-backed encryption.
		encryptString: (plain: string) => Buffer.from(`enc:${plain}`, "utf8"),
		decryptString: (buf: Buffer) => buf.toString("utf8").replace(/^enc:/, ""),
	},
}));

mock.module("./local-db", () => ({
	localDb: {
		select: () => ({
			from: () => ({ get: () => settingsRow }),
		}),
		insert: () => ({
			values: (values: { providerApiKeys?: Record<string, string> }) => ({
				onConflictDoUpdate: (args: {
					set: { providerApiKeys?: Record<string, string> };
				}) => ({
					run: () => {
						settingsRow = {
							...(settingsRow ?? {}),
							providerApiKeys: args.set.providerApiKeys,
						};
						void values;
					},
				}),
			}),
		}),
	},
}));

const {
	setProviderKey,
	setProviderAccountKey,
	setProviderAccountSecret,
	clearProviderKey,
	clearProviderAccountKey,
	clearProviderAccountSecret,
	hasProviderKey,
	hasProviderAccountKey,
	hasProviderAccountSecret,
	getProviderKey,
	getProviderAccountKey,
	getProviderAccountSecret,
	getProviderKeyStatus,
} = await import("./provider-keys");

describe("provider-keys", () => {
	beforeEach(() => {
		encryptionAvailable = true;
		settingsRow = null;
	});

	it("round-trips a stored key through encryption", () => {
		expect(hasProviderKey("openrouter")).toBe(false);
		expect(getProviderKey("openrouter")).toBeNull();

		setProviderKey("openrouter", "sk-or-test-123");

		expect(hasProviderKey("openrouter")).toBe(true);
		expect(getProviderKey("openrouter")).toBe("sk-or-test-123");
		expect(getProviderKeyStatus()).toEqual(
			expect.objectContaining({ openrouter: true, openai: false }),
		);

		// Persisted value must be the encrypted blob, never plaintext.
		expect(settingsRow?.providerApiKeys?.openrouter).not.toContain(
			"sk-or-test-123",
		);
	});

	it("trims surrounding whitespace before storing", () => {
		setProviderKey("openrouter", "  sk-or-trim  ");
		expect(getProviderKey("openrouter")).toBe("sk-or-trim");
	});

	it("rejects a blank key", () => {
		expect(() => setProviderKey("openrouter", "   ")).toThrow();
		expect(hasProviderKey("openrouter")).toBe(false);
	});

	it("clears a stored key", () => {
		setProviderKey("openrouter", "sk-or-clear");
		expect(hasProviderKey("openrouter")).toBe(true);

		clearProviderKey("openrouter");

		expect(hasProviderKey("openrouter")).toBe(false);
		expect(getProviderKey("openrouter")).toBeNull();
		expect(getProviderKeyStatus()).toEqual(
			expect.objectContaining({ openrouter: false, openai: false }),
		);
	});

	it("stores independent account keys per provider", () => {
		setProviderAccountKey("openrouter", "account-a", "sk-or-a");
		setProviderAccountKey("openrouter", "account-b", "sk-or-b");

		expect(hasProviderKey("openrouter")).toBe(true);
		expect(hasProviderAccountKey("openrouter", "account-a")).toBe(true);
		expect(getProviderAccountKey("openrouter", "account-a")).toBe("sk-or-a");
		expect(getProviderAccountKey("openrouter", "account-b")).toBe("sk-or-b");
		expect(getProviderKeyStatus()).toEqual(
			expect.objectContaining({ openrouter: true }),
		);

		clearProviderAccountKey("openrouter", "account-a");

		expect(getProviderAccountKey("openrouter", "account-a")).toBeNull();
		expect(getProviderAccountKey("openrouter", "account-b")).toBe("sk-or-b");
	});

	it("stores independent account secrets alongside account keys", () => {
		setProviderAccountKey("openai", "account-a", "access-token");
		setProviderAccountSecret("openai", "account-a", "refresh", "refresh-token");
		setProviderAccountSecret("openai", "account-a", "id", "id-token");

		expect(hasProviderAccountSecret("openai", "account-a", "refresh")).toBe(
			true,
		);
		expect(getProviderAccountSecret("openai", "account-a", "refresh")).toBe(
			"refresh-token",
		);
		expect(getProviderAccountSecret("openai", "account-a", "id")).toBe(
			"id-token",
		);

		clearProviderAccountSecret("openai", "account-a", "id");
		expect(getProviderAccountSecret("openai", "account-a", "id")).toBeNull();

		clearProviderAccountKey("openai", "account-a");
		expect(getProviderAccountKey("openai", "account-a")).toBeNull();
		expect(
			getProviderAccountSecret("openai", "account-a", "refresh"),
		).toBeNull();
	});

	it("degrades gracefully when secure storage is unavailable", () => {
		encryptionAvailable = false;
		expect(() => setProviderKey("openrouter", "sk-or-x")).toThrow();

		// A previously stored blob cannot be decrypted without safeStorage.
		encryptionAvailable = true;
		setProviderKey("openrouter", "sk-or-y");
		encryptionAvailable = false;
		expect(getProviderKey("openrouter")).toBeNull();
	});
});
