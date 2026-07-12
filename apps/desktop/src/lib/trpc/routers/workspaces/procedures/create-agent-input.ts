import { AGENT_RUNTIMES } from "@superset/local-db/schema/zod";
import { z } from "zod";

/**
 * Input schema for the createAgent procedure. Kept in its own module (importing
 * only zod + the light schema constants, no DB / main-process singletons) so the
 * validation — notably the optional `role` field — is unit-testable in isolation.
 */
export const createAgentInput = z.object({
	projectId: z.string(),
	name: z.string().min(1),
	// Optional free-text identity captured at creation. Trimmed; empty becomes
	// undefined so the scaffold treats it as unset.
	role: z
		.string()
		.trim()
		.max(280)
		.optional()
		.transform((v) => (v ? v : undefined)),
	runtime: z.enum(AGENT_RUNTIMES).default("orchestrator"),
	repo: z
		.discriminatedUnion("type", [
			z.object({ type: z.literal("init") }),
			z.object({ type: z.literal("clone"), url: z.string().min(1) }),
		])
		.default({ type: "init" }),
});
