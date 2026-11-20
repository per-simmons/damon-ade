import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createTask,
	getTask,
	listSpecialists,
	listTaskRecords,
	loadWorkflowSettings,
	resolveSpecialist,
	saveTask,
	type TaskRecord,
} from "main/lib/agent-workflow";
import { parseSplit } from "main/lib/agent-workflow/split";
import { getLocalToken } from "main/lib/notifications/local-auth";
import { defaultWorkflowRouterDeps, type WorkflowRouterDeps } from "./workflow";

/**
 * The team chat as a Claude Code session. ADE starts `claude` in the team's
 * folder with this MCP server (served by ADE's local HTTP server, 127.0.0.1
 * only, behind the "team" token that only the session's MCP config file
 * holds). The server's instructions make the session the team's
 * Coordinator: it talks the work through with the user, reads the code
 * without editing, and when the user says go, hands the agreed plan to ADE
 * with start_plan. ADE then runs it as a team request: each subtask on its
 * specialist's agent, with checks and review.
 */

export const TEAM_MCP_NAME = "ade-team";
export const TEAM_CHAT_TAB = "Team chat";

const INSTRUCTIONS = `You are the Coordinator of this ADE team. The user talks with you here to plan work; the team's agents do it after the user says go.

- At the start of a conversation call team_overview once, to learn the team's specialists and which agent does each.
- Talk in short, plain sentences. Read the code only as much as you need to plan well; never edit files or build the work yourself.
- If something important is unclear (what they want, where it belongs, a choice only they can make), ask at most two short questions before planning.
- Propose a plan as a numbered list. For each subtask: a short title, what to change and how to know it is done, the specialist (by name, or "none"), the route ("quick", "implement", "plan" or "exceptional"), the model per role, and which earlier subtasks it waits for. Independent subtasks run at the same time on their agents. Revise the plan whenever the user asks.
- Models, as cheaply as is reliable: haiku only for trivial low-risk work, sonnet for normal work, opus for planning or reviewing difficult or risky work, fable only for exceptional architecture. Risky work (authentication, permissions, secrets, payments, data migrations, messaging people) is never "quick".
- Only when the user clearly says to start (for example "go"), call start_plan with their request and the exact plan you agreed. Then say it has started, and use plan_status when they ask how it is going.`;

const TOOLS = [
	{
		name: "team_overview",
		description:
			"The team's repository, its specialists (with the agent that does each, and their role models) and its latest team plans. Read-only.",
		inputSchema: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
	},
	{
		name: "start_plan",
		description:
			"Start the agreed plan: ADE creates one task per subtask, on the specialist's agent, and runs them (independent ones at the same time) with checks and review. This spends money on model runs. Call it only after the user has clearly said to start.",
		inputSchema: {
			type: "object",
			required: ["request", "plan"],
			properties: {
				request: {
					type: "string",
					description: "What the user asked for, in one or two sentences.",
				},
				plan: {
					type: "object",
					required: ["subtasks", "reason"],
					properties: {
						reason: {
							type: "string",
							description: "Why it is split this way, in one sentence.",
						},
						subtasks: {
							type: "array",
							minItems: 1,
							maxItems: 6,
							items: {
								type: "object",
								required: ["title", "description", "route"],
								properties: {
									title: { type: "string" },
									description: {
										type: "string",
										description:
											"What to change, the interfaces it uses or provides, and how to know it is done.",
									},
									specialist: {
										type: "string",
										description:
											'A specialist\'s name from team_overview, or "none".',
									},
									route: {
										type: "string",
										enum: ["quick", "implement", "plan", "exceptional"],
									},
									models: {
										type: "object",
										description:
											'Model per role, e.g. {"planner": "opus", "implementer": "sonnet", "reviewer": "sonnet"}.',
									},
									dependsOn: {
										type: "array",
										items: { type: "integer" },
										description:
											"Numbers (from 1) of earlier subtasks whose work this one needs; [] if none.",
									},
								},
							},
						},
					},
				},
			},
		},
	},
	{
		name: "plan_status",
		description:
			"How a started plan is going: each subtask's agent, state and reason. Without an id, the latest plan. Read-only.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "The plan id start_plan returned." },
			},
		},
	},
] as const;

/** The MCP config file the Coordinator session is started with (0600). */
export function writeTeamMcpConfig(
	homeDir: string,
	workspaceId: string,
	port: number,
): string {
	const dir = join(homeDir, "team-chat");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${workspaceId}.mcp.json`);
	const config = {
		mcpServers: {
			[TEAM_MCP_NAME]: {
				type: "http",
				url: `http://127.0.0.1:${port}/team-mcp/${encodeURIComponent(workspaceId)}`,
				headers: {
					Authorization: `Bearer ${getLocalToken(homeDir, "team")}`,
				},
			},
		},
	};
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	try {
		chmodSync(path, 0o600);
	} catch {
		// Best effort (no-op on Windows, where the profile folder is private).
	}
	return path;
}

/** The command that starts the Coordinator session in a terminal. */
export function teamChatCommand(configPath: string): string {
	const config = configPath.replace(/\\/g, "/");
	return [
		"claude",
		`--name "${TEAM_CHAT_TAB}"`,
		`--mcp-config "${config}"`,
		// The Coordinator plans; the agents do the work.
		"--disallowedTools Edit Write NotebookEdit",
		`--allowedTools mcp__${TEAM_MCP_NAME}__team_overview mcp__${TEAM_MCP_NAME}__plan_status`,
		`--append-system-prompt "You are the Coordinator of this ADE team. Follow the ${TEAM_MCP_NAME} server's instructions: plan the work with the user, never edit files, and start it only with start_plan after they say go."`,
	].join(" ");
}

type JsonRpcId = string | number | null;
interface JsonRpcRequest {
	jsonrpc?: string;
	id?: JsonRpcId;
	method?: string;
	params?: Record<string, unknown>;
}

const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

function text(value: string, isError = false) {
	return {
		content: [{ type: "text", text: value }],
		...(isError ? { isError } : {}),
	};
}

function teamRequests(tasks: TaskRecord[]): TaskRecord[] {
	return tasks
		.filter((t) => t.isRequest)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function describePlan(request: TaskRecord, all: TaskRecord[]): string {
	const subtasks = (request.subtaskSlugs ?? []).map((slug) =>
		all.find((t) => t.slug === slug),
	);
	const lines = subtasks.map((sub, i) =>
		sub
			? `${i + 1}. ${sub.title} — ${sub.agentName ? `${sub.agentName}, ` : ""}${sub.state}${sub.stateReason && sub.state !== "done" ? ` (${sub.stateReason})` : ""}`
			: `${i + 1}. (missing)`,
	);
	return [
		`Plan ${request.slug}: "${request.title}" — ${request.state}${request.stateReason ? `: ${request.stateReason}` : ""}`,
		...lines,
	].join("\n");
}

export function createTeamMcpHandler(
	deps: WorkflowRouterDeps = defaultWorkflowRouterDeps,
) {
	const overview = (workspaceId: string): string => {
		const ctx = deps.resolveWorkspace(workspaceId);
		const home = deps.homeDir();
		const settings = loadWorkflowSettings(home);
		const agents = deps.listAgents?.(workspaceId) ?? [];
		const specialists = listSpecialists(ctx.project).map((s) => {
			const resolved = resolveSpecialist(s, settings, home);
			const agent = agents.find((a) => a.workspaceId === s.agentWorkspaceId);
			const roles = Object.values(resolved.roles)
				.map((r) => `${r.label} ${r.model}/${r.effort}`)
				.join(", ");
			return `- "${s.name}" (${s.specialty})${agent ? `, done by the agent "${agent.name}"` : ", no agent (runs in the team's folder)"}. Roles: ${roles}`;
		});
		const plans = teamRequests(listTaskRecords(ctx.project))
			.slice(0, 5)
			.map((t) => `- ${t.slug}: "${t.title}" — ${t.state}`);
		return [
			`Team "${ctx.project.name}", repository ${ctx.project.root}.`,
			"",
			"Specialists:",
			...(specialists.length
				? specialists
				: ["- none: every subtask uses the default workflow"]),
			"",
			`Agents: ${agents.map((a) => a.name).join(", ") || "none"}.`,
			"",
			"Latest plans:",
			...(plans.length ? plans : ["- none yet"]),
		].join("\n");
	};

	const startPlan = async (
		workspaceId: string,
		args: Record<string, unknown>,
	): Promise<ReturnType<typeof text>> => {
		const request = typeof args.request === "string" ? args.request.trim() : "";
		if (!request) return text("start_plan needs the user's request.", true);
		const plan = parseSplit(
			`\`\`\`json\n${JSON.stringify(args.plan ?? {})}\n\`\`\``,
		);
		if (!plan) {
			return text(
				"The plan could not be read: it needs subtasks, each with a title and a description.",
				true,
			);
		}
		const ctx = deps.resolveWorkspace(workspaceId);
		const execution = loadWorkflowSettings(deps.homeDir()).execution;
		const created = createTask(ctx.project, {
			description: request,
			mode: "auto",
			identity: deps.captureIdentity(workspaceId, ctx.worktreePath),
			limits: {
				budgetUsd: execution.taskBudgetUsd,
				maxCorrections: execution.maxCorrections,
				maxReviewRounds: execution.maxReviewRounds,
				maxEscalations: execution.maxEscalations,
			},
		});
		const now = new Date().toISOString();
		const task: TaskRecord = {
			...created,
			isRequest: true,
			chat: [
				{ role: "user", text: request, at: now },
				{
					role: "coordinator",
					text: "Plan agreed in the Team chat tab (Claude Code).",
					at: now,
					plan,
				},
			],
			teamAgents: deps.listAgents?.(workspaceId) ?? [],
			routeBy: "ai",
			routeReasons: ["planned in the Team chat tab"],
			specialistReason: "the Coordinator assigns a specialist to each subtask",
		};
		saveTask(ctx.project, task);
		await deps.controller().approvePlan(ctx.project, task.slug);
		const all = listTaskRecords(ctx.project);
		const started = getTask(ctx.project, task.slug) ?? task;
		return text(
			`Started. ${describePlan(started, all)}\n\nProgress also shows in ADE (Tasks, and Team plans).`,
		);
	};

	const status = (workspaceId: string, args: Record<string, unknown>) => {
		const ctx = deps.resolveWorkspace(workspaceId);
		const all = listTaskRecords(ctx.project);
		const id = typeof args.id === "string" ? args.id.trim() : "";
		const request = id
			? all.find((t) => t.slug === id && t.isRequest)
			: teamRequests(all).find((t) => (t.subtaskSlugs?.length ?? 0) > 0);
		if (!request)
			return text(id ? `No plan ${id}.` : "No plan has started yet.", !!id);
		return text(describePlan(request, all));
	};

	const call = async (
		workspaceId: string,
		name: string,
		args: Record<string, unknown>,
	) => {
		switch (name) {
			case "team_overview":
				return text(overview(workspaceId));
			case "start_plan":
				return startPlan(workspaceId, args);
			case "plan_status":
				return status(workspaceId, args);
			default:
				return text(`Unknown tool ${name}`, true);
		}
	};

	/** One JSON-RPC message; undefined for a notification (no reply). */
	const handleOne = async (workspaceId: string, message: JsonRpcRequest) => {
		const id = message.id ?? null;
		const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
		const fail = (code: number, msg: string) => ({
			jsonrpc: "2.0",
			id,
			error: { code, message: msg },
		});
		if (message.id === undefined) return undefined;
		try {
			switch (message.method) {
				case "initialize": {
					const asked = String(message.params?.protocolVersion ?? "");
					return reply({
						protocolVersion: SUPPORTED_VERSIONS.includes(asked)
							? asked
							: SUPPORTED_VERSIONS[0],
						capabilities: { tools: {} },
						serverInfo: { name: TEAM_MCP_NAME, version: "1.0.0" },
						instructions: INSTRUCTIONS,
					});
				}
				case "ping":
					return reply({});
				case "tools/list":
					return reply({ tools: TOOLS });
				case "tools/call": {
					const name = String(message.params?.name ?? "");
					const args = (message.params?.arguments ?? {}) as Record<
						string,
						unknown
					>;
					return reply(await call(workspaceId, name, args));
				}
				default:
					return fail(-32601, `Method not found: ${message.method}`);
			}
		} catch (error) {
			if (message.method === "tools/call") {
				return reply(
					text(error instanceof Error ? error.message : String(error), true),
				);
			}
			return fail(
				-32603,
				error instanceof Error ? error.message : String(error),
			);
		}
	};

	/** A POST body: one message or a batch. Undefined means 202, no body. */
	return async (workspaceId: string, body: unknown) => {
		if (Array.isArray(body)) {
			const replies = (
				await Promise.all(
					body.map((m) => handleOne(workspaceId, m as JsonRpcRequest)),
				)
			).filter((r) => r !== undefined);
			return replies.length ? replies : undefined;
		}
		return handleOne(workspaceId, (body ?? {}) as JsonRpcRequest);
	};
}
