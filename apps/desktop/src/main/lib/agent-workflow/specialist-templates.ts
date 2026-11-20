import type {
	CustomRole,
	RoleOverride,
	SpecialistTemplate,
} from "./specialists";

/**
 * Built-in specialty templates. A template is a starting point: its
 * instructions, routing keywords, role overrides and optional extra roles
 * are read live from here, while everything the user edits is stored on the
 * specialist (or in a personal template), so updating these never
 * overwrites a user's changes.
 *
 * Models are role-relative aliases (haiku, sonnet, opus, fable) resolved
 * through models.ts; a template only names a model where the specialty
 * needs a different one than the global default for that role.
 */

const reviewRole = (
	id: string,
	name: string,
	description: string,
	instructions: string,
	keywords: string[],
	extra: Partial<CustomRole> = {},
): CustomRole => ({
	id,
	name,
	description,
	instructions,
	access: "read-only",
	trigger: "after-implementation",
	keywords,
	expectedOutput:
		"Findings ordered by severity, each with file and line, then exactly one line `VERDICT: PASS` or `VERDICT: FAIL`.",
	...extra,
});

const planner = (focus: string): RoleOverride => ({
	instructions: `As a planner for this specialty, make the plan cover: ${focus}`,
});
const reviewer = (focus: string, model?: string): RoleOverride => ({
	instructions: `As a reviewer for this specialty, check in particular: ${focus}`,
	...(model ? { model } : {}),
});

export const BUILT_IN_TEMPLATES: SpecialistTemplate[] = [
	{
		id: "ui",
		builtIn: true,
		name: "UI",
		specialty: "UI",
		keywords: [
			"ui",
			"component",
			"button",
			"layout",
			"style",
			"css",
			"tailwind",
			"screen",
			"modal",
			"dialog",
			"icon",
			"theme",
		],
		instructions: `You build user interface components.
- Reuse the project's existing design system and components before creating new ones; match their naming, props and styling conventions.
- Keep component structure consistent with neighbouring components (one component per file where the project does that).
- Cover loading, empty, error and disabled states, not only the happy path.
- Make layouts responsive at the breakpoints the project already uses.
- Make interactive elements clear: visible focus, sensible hover/active states, labels that say what happens.
- Apply accessibility appropriate to the component: semantic elements, labels, keyboard operation, contrast.`,
		roles: {
			planner: planner(
				"affected components, states (loading/empty/error/disabled), responsive behaviour, and which existing components to reuse.",
			),
			reviewer: reviewer(
				"design-system consistency, missing states, responsive behaviour, keyboard operation and labels.",
			),
		},
		customRoles: [
			reviewRole(
				"ui-accessibility-reviewer",
				"Accessibility Reviewer",
				"Checks changed UI for accessibility problems.",
				"Review only the changed UI for accessibility: semantic roles, accessible names and labels, keyboard reachability and order, focus management in dialogs and menus, colour contrast, and announcements for dynamic content. Report concrete problems with file and line; do not restyle.",
				[
					"form",
					"input",
					"dialog",
					"modal",
					"menu",
					"keyboard",
					"focus",
					"aria",
					"a11y",
					"accessib",
					"contrast",
					"screen reader",
				],
			),
		],
	},
	{
		id: "ux",
		builtIn: true,
		name: "UX",
		specialty: "UX",
		keywords: [
			"ux",
			"flow",
			"journey",
			"onboarding",
			"usability",
			"discoverab",
			"copy",
			"wording",
			"empty state",
			"friction",
		],
		instructions: `You improve how the product works for its users.
- Start from the user's journey: what they are trying to do, where they start, and what they see at each step.
- Make features discoverable where users look for them; avoid hidden or dead-end routes.
- Keep information hierarchy clear: the most important action and status first.
- Remove friction: fewer steps, sensible defaults, no repeated input.
- Give feedback for every action and a way to recover from errors (undo, retry, clear messages).
- Use plain, specific language; say what will happen before it happens.
- Consider keyboard use and accessibility as part of the flow.`,
		roles: {
			planner: planner(
				"the user journey before and after the change, defaults, wording, error recovery and discoverability.",
			),
			reviewer: reviewer(
				"whether the journey is discoverable, the wording is clear, and errors can be recovered from.",
			),
		},
		customRoles: [],
	},
	{
		id: "frontend",
		builtIn: true,
		name: "Frontend",
		specialty: "Frontend",
		keywords: [
			"frontend",
			"react",
			"state",
			"hook",
			"render",
			"client",
			"page",
			"route",
			"fetch",
			"query",
			"store",
		],
		instructions: `You work on the client application.
- Follow the project's existing state and data-flow patterns (stores, query hooks, context) instead of introducing new ones.
- Keep rendering efficient: avoid unnecessary re-renders and effects; derive state instead of duplicating it.
- Respect client/server boundaries the framework defines.
- Integrate with existing APIs through the project's established client layer; handle loading and error responses.
- Keep accessibility and performance in mind for anything user-facing.
- Add or update component and integration tests where the project has them.`,
		roles: {
			planner: planner(
				"data flow, state ownership, API calls and their error handling, and tests to add.",
			),
			reviewer: reviewer(
				"state and data flow, error handling of API calls, unnecessary re-renders, and test coverage.",
			),
		},
		customRoles: [],
	},
	{
		id: "backend",
		builtIn: true,
		name: "Backend",
		specialty: "Backend",
		keywords: [
			"backend",
			"server",
			"service",
			"api",
			"endpoint",
			"handler",
			"database",
			"queue",
			"job",
			"worker",
			"auth",
			"validation",
		],
		instructions: `You work on server-side logic.
- Follow the existing service, module and error-handling conventions of this codebase.
- Validate inputs at the boundary; never trust client data.
- Enforce authorization where data is read or changed, not only in the UI.
- Make operations reliable: handle partial failure, make retries idempotent where they can repeat.
- Return errors with the project's established shapes and status codes.
- Add or update API and integration tests for the behaviour you change.`,
		roles: {
			planner: planner(
				"data validation, authorization checks, failure handling and idempotency, and the tests that prove them.",
			),
			reviewer: reviewer(
				"input validation, authorization, error handling, idempotency and missing tests.",
			),
		},
		customRoles: [
			reviewRole(
				"backend-api-contract-reviewer",
				"API Contract Reviewer",
				"Checks changed endpoints for contract and compatibility problems.",
				"Review only changed endpoints and their types: request/response shapes, backward compatibility for existing clients, validation, status codes and error semantics, and whether consumers or docs need updating.",
				[
					"api",
					"endpoint",
					"route",
					"request",
					"response",
					"contract",
					"schema",
					"trpc",
					"rest",
					"graphql",
				],
			),
		],
	},
	{
		id: "api",
		builtIn: true,
		name: "API",
		specialty: "API development",
		keywords: [
			"api",
			"endpoint",
			"contract",
			"openapi",
			"rest",
			"graphql",
			"trpc",
			"sdk",
			"webhook",
		],
		instructions: `You design and change APIs.
- Treat the contract as the product: request and response shapes, status codes and error semantics are deliberate.
- Keep changes backward compatible unless the task says otherwise; version or deprecate instead of breaking clients.
- Validate requests and responses with the project's schema tooling.
- Require the right authentication and authorization for every operation.
- Update documentation and consumers affected by the change.`,
		roles: {
			planner: planner(
				"the contract change, compatibility for existing clients, validation, auth and documentation updates.",
			),
			reviewer: reviewer(
				"contract compatibility, validation, auth and error semantics.",
			),
		},
		customRoles: [],
	},
	{
		id: "database",
		builtIn: true,
		name: "Database",
		specialty: "Database",
		keywords: [
			"database",
			"schema",
			"migration",
			"sql",
			"query",
			"index",
			"table",
			"column",
			"orm",
			"drizzle",
			"prisma",
		],
		instructions: `You work on data storage.
- Design schema changes for data integrity: constraints, nullability, defaults and relations.
- Write queries that are correct first, then efficient; check indexes for new access patterns.
- Plan migrations safely: existing rows, backfills, locking and rollback.
- Follow this repository's migration rules exactly (for example generated migration files that must not be edited by hand, or migrations the user runs themselves).
- Never run a migration against a shared or production database.`,
		roles: {
			planner: planner(
				"schema and migration steps, effect on existing data, indexes, and the repository's migration rules.",
			),
			reviewer: reviewer(
				"data integrity, migration safety on existing rows, query correctness and indexes.",
			),
		},
		customRoles: [
			reviewRole(
				"database-migration-reviewer",
				"Migration Reviewer",
				"Checks migrations for data loss and unsafe operations.",
				"Review only migration and schema changes: data loss, unsafe locking on large tables, missing backfills or defaults, irreversible steps, and edits to generated migration files the repository forbids.",
				[
					"migration",
					"schema",
					"column",
					"table",
					"index",
					"alter",
					"drizzle",
					"prisma",
				],
			),
		],
	},
	{
		id: "qa",
		builtIn: true,
		name: "QA and testing",
		specialty: "QA and testing",
		keywords: [
			"test",
			"tests",
			"qa",
			"regression",
			"flaky",
			"coverage",
			"e2e",
			"reproduce",
			"bug",
		],
		instructions: `You make sure work is verifiably done.
- Turn the request into checkable acceptance criteria.
- Choose the smallest set of tests that prove them; prefer the project's existing test style.
- Reproduce a bug with a failing test before fixing it where practical.
- Add regression coverage for fixed defects.
- Diagnose failures from their output instead of retrying blindly.
- Report evidence: which command ran and what it showed.`,
		roles: {
			planner: planner(
				"acceptance criteria and the tests or commands that prove each one.",
			),
			reviewer: reviewer(
				"whether each acceptance criterion is covered by a test or check that actually ran.",
			),
		},
		customRoles: [],
	},
	{
		id: "security",
		builtIn: true,
		name: "Security",
		specialty: "Security",
		keywords: [
			"security",
			"auth",
			"token",
			"secret",
			"permission",
			"injection",
			"xss",
			"csrf",
			"upload",
			"exec",
			"encrypt",
			"password",
		],
		instructions: `You work with security in mind.
- Identify trust boundaries the change crosses: user input, network, filesystem, other processes.
- Check authentication and authorization on every changed operation.
- Keep secrets out of code, logs, URLs and error messages.
- Validate and encode input; never build shell commands or queries by string interpolation.
- Constrain file and command execution to what the feature needs.
- Consider dependency and integration risks the change introduces.`,
		roles: {
			planner: planner(
				"trust boundaries, authorization, secret handling and input validation for the change.",
			),
			reviewer: reviewer(
				"authorization, secret exposure, injection and unsafe file or command execution.",
				"opus",
			),
		},
		customRoles: [
			reviewRole(
				"security-threat-modeler",
				"Threat Modeler",
				"Lists the threats a sensitive change must handle before it is built.",
				"Before implementation, list the realistic threats for this change (who could abuse it and how), with the mitigation the implementation must include for each. Read only the code needed; do not edit files.",
				[
					"auth",
					"login",
					"token",
					"secret",
					"permission",
					"upload",
					"exec",
					"shell",
					"password",
					"encrypt",
					"session",
				],
				{
					trigger: "before-implementation",
					expectedOutput:
						"A short threat list with a required mitigation for each, then `VERDICT: PASS` (the mitigations are in the plan or task) or `VERDICT: FAIL` (something essential is unaddressed).",
				},
			),
		],
	},
	{
		id: "devops",
		builtIn: true,
		name: "DevOps",
		specialty: "DevOps",
		keywords: [
			"ci",
			"deploy",
			"docker",
			"pipeline",
			"workflow",
			"build",
			"release",
			"infra",
			"kubernetes",
			"terraform",
			"github actions",
		],
		instructions: `You work on build, release and operations.
- Follow the project's existing build and deployment conventions.
- Keep configuration explicit and environment-specific values out of code.
- Make changes reliable and recoverable: idempotent steps, clear failure output, a way back.
- Add observability where the change can fail silently.
- Never print or commit secrets; reference them through the platform's secret store.
- Do not deploy or publish anything as part of a task.`,
		roles: {
			planner: planner(
				"affected pipelines and environments, rollback, and secret handling.",
			),
			reviewer: reviewer("secret exposure, reproducibility and rollback."),
		},
		customRoles: [],
	},
	{
		id: "performance",
		builtIn: true,
		name: "Performance",
		specialty: "Performance",
		keywords: [
			"performance",
			"slow",
			"latency",
			"optimiz",
			"memory",
			"cpu",
			"profil",
			"benchmark",
			"cache",
		],
		instructions: `You improve performance with evidence.
- Find the actual bottleneck before changing code; measure where practical.
- Prefer the simplest change that removes the measured cost; avoid speculative optimization.
- Check that the change does not regress correctness or other paths.
- Keep measurements cheap and repeatable; record before and after numbers.`,
		roles: {
			planner: planner(
				"how the bottleneck is measured, the change, and how improvement and regressions are checked.",
			),
			reviewer: reviewer(
				"whether the improvement is measured and correctness is preserved.",
			),
		},
		customRoles: [],
	},
	{
		id: "documentation",
		builtIn: true,
		name: "Documentation",
		specialty: "Documentation",
		keywords: [
			"doc",
			"docs",
			"readme",
			"documentation",
			"guide",
			"changelog",
			"comment",
			"typo",
		],
		instructions: `You write documentation.
- Describe the behaviour as implemented; read the code before documenting it.
- Write clear, specific instructions a new user can follow.
- Keep examples correct and runnable.
- Match the existing documentation's tone, structure and terminology.
- Do not claim support for things the code does not do.`,
		roles: {
			quick: { model: "haiku" },
			reviewer: reviewer(
				"accuracy against the code and whether examples work.",
			),
		},
		customRoles: [],
	},
	{
		id: "mobile",
		builtIn: true,
		name: "Mobile",
		specialty: "Mobile development",
		keywords: [
			"mobile",
			"ios",
			"android",
			"react native",
			"expo",
			"swift",
			"kotlin",
			"app store",
		],
		instructions: `You build mobile app features.
- Follow platform conventions for navigation, gestures and system UI.
- Handle lifecycle: backgrounding, resume, interrupted work.
- Respect device constraints: small screens, battery, flaky networks, offline.
- Provide accessible touch targets and screen reader labels.
- Use the project's framework conventions (for example Expo or native modules) rather than new libraries.`,
		roles: {
			planner: planner(
				"navigation, lifecycle, offline/error behaviour and platform differences.",
			),
			reviewer: reviewer(
				"lifecycle handling, offline/error states and platform conventions.",
			),
		},
		customRoles: [],
	},
	{
		id: "desktop",
		builtIn: true,
		name: "Desktop",
		specialty: "Desktop development",
		keywords: [
			"desktop",
			"electron",
			"ipc",
			"window",
			"tray",
			"native",
			"installer",
			"menu",
		],
		instructions: `You build desktop application features.
- Keep privileged work in the main process and pass only what is needed over IPC; validate IPC input.
- Handle the application lifecycle: windows closing, app quitting, single instance, restarts.
- Be careful with filesystem access: user paths, permissions, Windows and macOS differences.
- Keep packaging working: native modules, paths inside the packaged app.
- Follow this project's existing Electron and IPC conventions.`,
		roles: {
			planner: planner(
				"process boundaries, IPC validation, lifecycle and packaging impact.",
			),
			reviewer: reviewer(
				"IPC validation, privilege boundaries, lifecycle and cross-platform paths.",
			),
		},
		customRoles: [],
	},
	{
		id: "gamedev",
		builtIn: true,
		name: "Game development",
		specialty: "Game development",
		keywords: [
			"game",
			"gameplay",
			"unreal",
			"unity",
			"godot",
			"player",
			"level",
			"physics",
			"input",
			"shader",
			"blueprint",
		],
		instructions: `You work on games.
- Identify the engine and follow its conventions (for example Unreal C++/Blueprints, Unity C#, Godot GDScript).
- Keep gameplay state and input handling predictable and frame-rate independent.
- Mind performance budgets per frame; avoid work in hot loops.
- Describe how to reproduce and play-test the change.`,
		roles: {
			planner: planner(
				"engine-specific approach, gameplay state, performance per frame, and play-test steps.",
			),
			reviewer: reviewer(
				"frame-rate independence, per-frame cost, and engine conventions.",
			),
		},
		customRoles: [
			reviewRole(
				"gamedev-gameplay-reviewer",
				"Gameplay Systems Reviewer",
				"Checks gameplay changes for state and timing bugs.",
				"Review only changed gameplay systems: state transitions, frame-rate dependence, input edge cases, and interactions with existing systems. Suggest a concrete play-test.",
				[
					"gameplay",
					"player",
					"input",
					"physics",
					"ability",
					"combat",
					"movement",
				],
			),
		],
	},
];
