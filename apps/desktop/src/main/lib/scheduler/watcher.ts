import { existsSync, type FSWatcher, readFileSync, watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Lightweight, NON-LLM event watcher. Detects new files in configured drops
 * (e.g. a new Krisp transcript) and fires the autonomous-agent endpoint
 * (POST 127.0.0.1:<port>/agent/invoke). The actual thinking happens in the
 * agent's session on the subscription — this just pings.
 *
 * Opt-in: reads ~/agents/watchers.json. If absent, does nothing (safe default).
 *
 *   [{ "dir": "/abs/path/to/krisp/transcripts",
 *      "agent": "marcus",
 *      "promptTemplate": "A call just ended. Read the new transcript at {file}, draft the recap per your recap-notes skill as a Gmail draft, and update the client note." }]
 */
interface WatcherConfig {
	dir: string;
	agent: string;
	promptTemplate: string; // {file} is replaced with the new file's absolute path
}

const WATCHERS_PATH = join(homedir(), "agents", "watchers.json");

export class AgentWatcher {
	private watchers: FSWatcher[] = [];
	private readonly seen = new Set<string>();
	private debounce = new Map<string, NodeJS.Timeout>();

	constructor(private readonly port: number) {}

	start(): void {
		if (!existsSync(WATCHERS_PATH)) return;
		let configs: WatcherConfig[] = [];
		try {
			configs = JSON.parse(
				readFileSync(WATCHERS_PATH, "utf8"),
			) as WatcherConfig[];
		} catch (err) {
			console.error("[agent-watcher] bad watchers.json:", err);
			return;
		}
		for (const cfg of configs) {
			if (!cfg.dir || !existsSync(cfg.dir)) continue;
			try {
				const w = watch(cfg.dir, (_eventType, filename) => {
					if (!filename) return;
					const full = join(cfg.dir, filename.toString());
					// Debounce per-file (editors/uploads fire multiple events).
					const prev = this.debounce.get(full);
					if (prev) clearTimeout(prev);
					this.debounce.set(
						full,
						setTimeout(() => {
							this.debounce.delete(full);
							if (this.seen.has(full) || !existsSync(full)) return;
							this.seen.add(full);
							void this.fire(cfg, full);
						}, 1500),
					);
				});
				this.watchers.push(w);
				console.log(
					`[agent-watcher] watching ${cfg.dir} → agent "${cfg.agent}"`,
				);
			} catch (err) {
				console.error(`[agent-watcher] failed to watch ${cfg.dir}:`, err);
			}
		}
	}

	private async fire(cfg: WatcherConfig, file: string): Promise<void> {
		const prompt = cfg.promptTemplate.replace(/\{file\}/g, file);
		try {
			await fetch(`http://127.0.0.1:${this.port}/agent/invoke`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ agent: cfg.agent, prompt }),
			});
			console.log(`[agent-watcher] fired ${cfg.agent} for ${file}`);
		} catch (err) {
			console.error("[agent-watcher] invoke failed:", err);
		}
	}

	stop(): void {
		for (const w of this.watchers) {
			try {
				w.close();
			} catch {}
		}
		this.watchers = [];
		for (const t of this.debounce.values()) clearTimeout(t);
		this.debounce.clear();
	}
}
