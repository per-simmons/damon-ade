/**
 * Runtime feature flags (main process, read from env once at load).
 */

/**
 * Memory / Agent-Files feature. Default ON — this is the revealed, final state.
 * Agent creation scaffolds the canonical memory/*.md files + write-back protocol
 * and the per-runtime bridges (CLAUDE.md + .claude/settings.json for Claude Code,
 * and .codex/AGENTS.md for codex), and the Agent Files panel shows the live
 * memory. Set ADE_MEMORY_SCAFFOLD=false only as an escape hatch to hold it back;
 * the staging gate served its purpose and is no longer the default.
 */
export const MEMORY_SCAFFOLD_ENABLED =
	process.env.ADE_MEMORY_SCAFFOLD !== "false";
