/**
 * Watches `~/.ade/app-state.json` for peer-originated changes
 * (i.e. writes that Syncthing pulled in from another Mac) and
 * emits parsed snapshots so the tRPC `sync` subscription router
 * can push them to the renderer.
 *
 * NOTE on chokidar vs node:fs.watch:
 *   The plan called for chokidar. chokidar is not a direct dep of
 *   apps/desktop and adding it would require touching the bun lockfile.
 *   For a SINGLE JSON file on macOS APFS, `fs.watch` is reliable and
 *   zero-dep. We replicate chokidar's `awaitWriteFinish` semantics with
 *   a simple debounce + stat-stability check (file must report the
 *   same size + mtime for `stabilityMs` before we emit).
 */

import { EventEmitter } from "node:events";
import { watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { APP_STATE_PATH } from "../app-environment";
import { getDeviceId } from ".";
import type { AppState } from "./schemas";

const DEBOUNCE_MS = 250;
const STABILITY_MS = 500;
const STABILITY_POLL_MS = 100;

export interface PeerAppStateUpdate {
	state: AppState;
}

class AppStateWatcher extends EventEmitter {
	declare emit: (event: "peer-update", payload: PeerAppStateUpdate) => boolean;
	declare on: (
		event: "peer-update",
		listener: (payload: PeerAppStateUpdate) => void,
	) => this;
	declare off: (
		event: "peer-update",
		listener: (payload: PeerAppStateUpdate) => void,
	) => this;
}

export const appStateWatcher = new AppStateWatcher();

let _started = false;
let _debounceTimer: NodeJS.Timeout | null = null;

async function waitForStability(): Promise<boolean> {
	let lastSize = -1;
	let lastMtimeMs = -1;
	let stableSince = 0;
	const startedAt = Date.now();
	const hardTimeoutMs = STABILITY_MS * 10;

	while (Date.now() - startedAt < hardTimeoutMs) {
		try {
			const s = await stat(APP_STATE_PATH);
			if (s.size === lastSize && s.mtimeMs === lastMtimeMs) {
				if (stableSince === 0) stableSince = Date.now();
				if (Date.now() - stableSince >= STABILITY_MS) return true;
			} else {
				lastSize = s.size;
				lastMtimeMs = s.mtimeMs;
				stableSince = 0;
			}
		} catch {
			// File missing during rename swap — try again.
		}
		await new Promise((r) => setTimeout(r, STABILITY_POLL_MS));
	}
	return false;
}

async function handleChange(): Promise<void> {
	const stable = await waitForStability();
	if (!stable) {
		console.warn("[app-state-watcher] File never stabilized; skipping read.");
		return;
	}

	let raw: string;
	try {
		raw = await readFile(APP_STATE_PATH, "utf8");
	} catch (err) {
		console.warn("[app-state-watcher] Failed to read app-state.json:", err);
		return;
	}

	let parsed: AppState;
	try {
		parsed = JSON.parse(raw) as AppState;
	} catch (err) {
		console.warn("[app-state-watcher] Failed to parse app-state.json:", err);
		return;
	}

	const localDeviceId = (() => {
		try {
			return getDeviceId();
		} catch {
			return null;
		}
	})();

	const writerDeviceId = parsed.sync?.deviceId ?? null;
	// Only react to peer writes — ignore our own.
	if (!writerDeviceId || !localDeviceId || writerDeviceId === localDeviceId) {
		return;
	}

	appStateWatcher.emit("peer-update", { state: parsed });
}

function scheduleHandle(): void {
	if (_debounceTimer) clearTimeout(_debounceTimer);
	_debounceTimer = setTimeout(() => {
		_debounceTimer = null;
		handleChange().catch((err) => {
			console.error("[app-state-watcher] handleChange failed:", err);
		});
	}, DEBOUNCE_MS);
}

export function startAppStateWatcher(): void {
	if (_started) return;
	_started = true;
	try {
		watch(APP_STATE_PATH, { persistent: true }, (eventType) => {
			if (eventType === "change" || eventType === "rename") {
				scheduleHandle();
			}
		});
		console.log(
			`[app-state-watcher] Watching ${APP_STATE_PATH} for peer updates.`,
		);
	} catch (err) {
		console.error("[app-state-watcher] Failed to start watcher:", err);
	}
}
