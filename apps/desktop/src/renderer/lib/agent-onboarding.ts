import type { AgentRuntime } from "@superset/local-db";
import { buildAgentPromptCommand } from "@superset/shared/agent-command";

const ONBOARDING_PROMPT = `This is your first session with this repository. Before anything else, onboard yourself:

1. Explore the repo: README, AGENTS.md, CLAUDE.md, docs/, and the top-level layout. If the repo contains AGENTS.md or CLAUDE.md instructions, they are authoritative — follow them in this and every future session.
2. Work out what this project is: purpose, tech stack, key directories, and how to install, run, test, and lint it.
3. Update your persistent memory files (your context bridge points at the canonical copies in ../memory/):
   - AGENT.md — refine your identity for THIS project: who you are, what you own, and how you work here.
   - MEMORY.md — durable project facts: what the project does, conventions (especially anything from AGENTS.md/CLAUDE.md), commands, and gotchas. Respect the size budgets described in the files.
4. Do not modify any project source files during onboarding — memory files only.
5. Finish with a short introduction: who you are and what this repo is.`;

/**
 * Launch command for a cloned agent's one-time first session: read the repo
 * (existing AGENTS.md/CLAUDE.md included) and write identity + memory from
 * what's actually there, instead of waking up with an undefined purpose.
 */
export function buildOnboardingCommand(runtime: AgentRuntime): string {
	return buildAgentPromptCommand({
		prompt: ONBOARDING_PROMPT,
		randomId: crypto.randomUUID(),
		agent: runtime,
	});
}
