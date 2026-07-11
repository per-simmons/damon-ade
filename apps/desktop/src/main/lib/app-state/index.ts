import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JSONFilePreset } from "lowdb/node";
import {
	APP_STATE_PATH,
	ensureSupersetHomeDirExists,
	SUPERSET_HOME_DIR,
	SUPERSET_SENSITIVE_FILE_MODE,
} from "../app-environment";
import type { AppState } from "./schemas";
import { defaultAppState } from "./schemas";

type AppStateDB = Awaited<ReturnType<typeof JSONFilePreset<AppState>>>;

let _appState: AppStateDB | null = null;

const DEVICE_ID_PATH = join(SUPERSET_HOME_DIR, "device-id");
let _deviceId: string | null = null;

/**
 * Read (or first-time generate) this machine's stable deviceId.
 * Persisted to `~/.ade/device-id`, which MUST be in Syncthing's
 * `.stignore` so each Mac generates its own.
 */
function loadOrCreateDeviceId(): string {
	ensureSupersetHomeDirExists();
	if (existsSync(DEVICE_ID_PATH)) {
		try {
			const value = readFileSync(DEVICE_ID_PATH, "utf8").trim();
			if (value.length > 0) return value;
		} catch (err) {
			console.warn("[app-state] Failed to read device-id, regenerating:", err);
		}
	}
	const id = randomUUID();
	try {
		writeFileSync(DEVICE_ID_PATH, id, {
			encoding: "utf8",
			mode: SUPERSET_SENSITIVE_FILE_MODE,
		});
	} catch (err) {
		console.error("[app-state] Failed to persist device-id:", err);
	}
	return id;
}

export function getDeviceId(): string {
	if (!_deviceId) {
		throw new Error("Device ID not initialized. Call initAppState() first.");
	}
	return _deviceId;
}

/**
 * Ensures loaded data has the correct shape by merging with defaults.
 * Handles legacy app-state.json files that may have a different structure
 * (e.g., from old electron-store format with keys like "tabs-storage").
 */
function ensureValidShape(data: Partial<AppState>, deviceId: string): AppState {
	return {
		tabsState: {
			...defaultAppState.tabsState,
			...(data.tabsState ?? {}),
		},
		themeState: {
			...defaultAppState.themeState,
			...(data.themeState ?? {}),
		},
		hotkeysState: {
			...defaultAppState.hotkeysState,
			...(data.hotkeysState ?? {}),
			byPlatform: {
				...defaultAppState.hotkeysState.byPlatform,
				...(data.hotkeysState?.byPlatform ?? {}),
			},
		},
		sync: {
			deviceId: data.sync?.deviceId ?? deviceId,
			lastWrittenAt: data.sync?.lastWrittenAt ?? 0,
			perWorkspaceWrittenAt: data.sync?.perWorkspaceWrittenAt ?? {},
			workspaceMetadata: data.sync?.workspaceMetadata ?? {},
			localToCanonical: data.sync?.localToCanonical ?? {},
			paneClaudeSessions: data.sync?.paneClaudeSessions ?? {},
		},
	};
}

export async function initAppState(): Promise<void> {
	if (_appState) return;

	_deviceId = loadOrCreateDeviceId();

	_appState = await JSONFilePreset<AppState>(APP_STATE_PATH, {
		...defaultAppState,
		sync: {
			...(defaultAppState.sync ?? {
				deviceId: _deviceId,
				lastWrittenAt: 0,
				perWorkspaceWrittenAt: {},
				workspaceMetadata: {},
				localToCanonical: {},
				paneClaudeSessions: {},
			}),
			deviceId: _deviceId,
		},
	});

	// Reshape data to ensure it has the correct structure (handles legacy formats)
	_appState.data = ensureValidShape(_appState.data, _deviceId);

	console.log(
		`App state initialized at: ${APP_STATE_PATH} (deviceId=${_deviceId.slice(0, 8)}...)`,
	);
}

export const appState = new Proxy({} as AppStateDB, {
	get(_target, prop) {
		if (!_appState) {
			throw new Error("App state not initialized. Call initAppState() first.");
		}
		const value = _appState[prop as keyof AppStateDB];
		// Bind methods to the real instance to preserve correct `this` context
		if (typeof value === "function") {
			return value.bind(_appState);
		}
		return value;
	},
});
