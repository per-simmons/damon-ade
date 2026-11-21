import type { EffortLevel } from "./agent-workflow";
import type {
	CustomRole,
	RoleOverride,
	SpecialistTemplate,
} from "./specialists";
import type { RoleName } from "./workflow-settings";

/**
 * Built-in specialty templates: recommended, balanced starting presets.
 *
 * Every template sets the model and reasoning effort of all five workflow
 * roles and specializes each role's instructions; maximum turns inherit the
 * global defaults. Additional roles are conditional: they run only when their
 * trigger applies (task wording or the files the task changed), never on
 * every task. Principles (2026-11): Opus plans and reviews (judgment-heavy,
 * costly to get wrong; an independent review by a stronger model than the
 * one that wrote the code), Sonnet implements (the everyday coder, about
 * half Opus's price), Haiku only for small low-risk work, Fable only as the
 * architect, which runs on the Exceptional route and on escalation, never on
 * every task. Effort scales with risk: low, medium or high; xhigh and max
 * are never preset.
 *
 * Templates are read live; user edits live on the specialist (or a personal
 * template), so updating these never overwrites a user's changes. Role ids
 * are stable: renaming a role here keeps its id.
 */

type ModelAlias = "haiku" | "sonnet" | "opus" | "fable";
type Preset = [ModelAlias, EffortLevel, string];

function roles(
	preset: Record<RoleName, Preset>,
): Record<RoleName, RoleOverride> {
	return Object.fromEntries(
		Object.entries(preset).map(([role, [model, effort, instructions]]) => [
			role,
			{ model, effort, instructions },
		]),
	) as Record<RoleName, RoleOverride>;
}

const VERDICT_OUTPUT =
	"Concrete findings ordered by severity, each with file and line and why it matters, plus what could not be verified; then exactly one line `VERDICT: PASS` or `VERDICT: FAIL`.";

function reviewer(
	role: Omit<CustomRole, "access" | "trigger" | "expectedOutput" | "maxTurns"> &
		Partial<Pick<CustomRole, "trigger" | "expectedOutput" | "maxTurns">>,
): CustomRole {
	return {
		access: "read-only",
		trigger: "after-implementation",
		expectedOutput: VERDICT_OUTPUT,
		maxTurns: 20,
		...role,
	};
}

const SHORT =
	"Quick Worker: only for small, clearly specified, low-risk changes. If the change turns out to need design decisions or touches risky code, stop and say it needs the implementer.";

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
			"spacing",
			"typography",
			"responsive",
		],
		instructions: `You build the visual interface.
- Reuse the project's design system and existing components before creating new ones; match their naming, props, tokens and styling conventions. Do not add a component library for something the project already has.
- Keep typography, spacing and hierarchy consistent with neighbouring screens.
- Cover loading, empty, error, success and disabled states, not only the happy path.
- Make layouts responsive at the breakpoints the project already uses.
- Keep keyboard operation and visible focus working for everything interactive.`,
		roles: roles({
			planner: [
				"opus",
				"medium",
				"List the affected components, every state they need (loading, empty, error, success, disabled), the breakpoints involved, and which existing primitives to reuse.",
			],
			architect: [
				"fable",
				"high",
				"Decide component boundaries and any design-system change (new token, variant or primitive); prefer extending what exists, and record why.",
			],
			implementer: [
				"sonnet",
				"medium",
				"Build the interface with the project's existing components, tokens and conventions; implement every state the plan lists.",
			],
			reviewer: [
				"opus",
				"medium",
				"Check visual consistency with the design system, interactions, responsive behaviour, keyboard operation and every missing state. Point to the exact component.",
			],
			quick: [
				"haiku",
				"medium",
				`${SHORT} Typical: a spacing, colour-token or label change in one component.`,
			],
		}),
		customRoles: [
			reviewer({
				id: "ui-accessibility-reviewer",
				name: "Accessibility Reviewer",
				description:
					"Checks changed interactive UI for accessibility problems.",
				instructions:
					"Review only the changed UI for accessibility: semantic elements and roles, accessible names and labels, keyboard operation and order, focus management in dialogs and menus, announcements for dynamic content, and contrast where evidence (tokens or values) exists. Report concrete issues with file and line and say what you could not verify. Never claim full accessibility compliance from code inspection alone.",
				keywords: [
					"form",
					"input",
					"dialog",
					"modal",
					"menu",
					"navigation",
					"keyboard",
					"focus",
					"aria",
					"a11y",
					"accessib",
					"contrast",
					"screen reader",
				],
				paths: ["dialog", "modal", "menu", "form", "nav"],
				model: "sonnet",
				effort: "high",
			}),
			reviewer({
				id: "ui-visual-consistency-reviewer",
				name: "Visual Consistency Reviewer",
				description:
					"Compares the result with the design system and the requested look.",
				instructions:
					"Compare the changed interface with the design system and the requested result: spacing, typography, colour tokens, alignment, iconography and states. Use screenshots or rendered output if the task folder or repository provides them; without rendered evidence, say clearly that your conclusion covers the code only.",
				keywords: [
					"visual",
					"pixel",
					"screenshot",
					"mockup",
					"figma",
					"looks",
					"spacing",
					"typography",
					"alignment",
					"polish",
				],
				model: "sonnet",
				effort: "medium",
			}),
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
			"wording",
			"empty state",
			"friction",
			"navigation",
			"steps",
			"settings page",
			"error message",
		],
		instructions: `You improve how people get things done in the product.
- Start from the user's goal: where they enter, what they must know first, and what tells them they succeeded.
- Make features discoverable where users look for them; remove dead ends and hidden controls.
- Keep navigation and information architecture predictable; the most important action and status come first.
- Reduce steps and repeated input; choose sensible defaults.
- Give feedback for every action and a clear way to recover from errors.
- Use plain, specific wording that says what will happen.
- Keep keyboard use and accessibility working across the whole journey.`,
		roles: roles({
			planner: [
				"opus",
				"medium",
				"Describe the current journey and the proposed one step by step (entry point, prerequisites, main path, failure path, completion feedback), and the wording that changes.",
			],
			architect: [
				"fable",
				"high",
				"Decide significant navigation or product-structure changes (where a feature lives, what is merged or split) and their effect on existing paths.",
			],
			implementer: [
				"sonnet",
				"medium",
				"Make the flow, interaction and wording changes; keep existing entry points working or redirect them.",
			],
			reviewer: [
				"opus",
				"medium",
				"Check that a user can discover the feature, complete the task, understand each label, and recover from errors; flag dead ends and repeated input.",
			],
			quick: [
				"haiku",
				"medium",
				`${SHORT} Typical: clearer wording on one label or message, or a better default.`,
			],
		}),
		customRoles: [
			reviewer({
				id: "ux-journey-reviewer",
				name: "Usability and Journey Reviewer",
				description: "Walks the changed journey end to end.",
				instructions:
					"Walk through the changed journey in the code: the actual entry point, prerequisites, main path, failure path and completion feedback. Identify hidden controls, dead ends, confusing labels, repeated input and missing recovery. Separate what you observed in the code from what you assume. Do not invent user research or claim real-user validation.",
				keywords: [
					"onboarding",
					"navigation",
					"flow",
					"wizard",
					"multi-step",
					"settings",
					"recover",
					"journey",
					"sign up",
					"checkout",
				],
				paths: ["onboarding", "settings", "wizard", "nav"],
				model: "sonnet",
				effort: "high",
			}),
		],
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
			"effect",
			"subscription",
		],
		instructions: `You work on client application logic.
- Keep one owner for each piece of state; derive instead of duplicating.
- Follow the project's data-flow patterns (stores, query hooks, context) and framework boundaries (client/server components, routing).
- Handle async behaviour fully: loading, errors, cancellation and stale responses.
- Integrate with APIs through the project's client layer.
- Keep rendering efficient without speculative micro-optimization; keep accessibility intact.
- Add or update component and integration tests where the project has them.`,
		roles: roles({
			planner: [
				"opus",
				"medium",
				"Identify state ownership, data flow, async calls and their failure handling, routing changes, and the tests to add.",
			],
			architect: [
				"fable",
				"high",
				"Decide state ownership and boundaries between components, stores and the server when they change.",
			],
			implementer: [
				"sonnet",
				"medium",
				"Implement with the project's state and data patterns; handle loading, error and cancellation.",
			],
			reviewer: [
				"opus",
				"medium",
				"Check state ownership, async correctness, error handling, framework boundaries and test coverage.",
			],
			quick: [
				"haiku",
				"medium",
				`${SHORT} Typical: a prop, a small conditional or a text change in one component.`,
			],
		}),
		customRoles: [
			reviewer({
				id: "frontend-state-reviewer",
				name: "State and Lifecycle Reviewer",
				description: "Checks shared state, effects and async lifecycles.",
				instructions:
					"Review changed shared state, effects, subscriptions, async requests and navigation: stale state, races, missing cleanup or cancellation, duplicate requests, derived state stored separately, and effects that should not exist. Every problem you report needs concrete evidence in the code. Avoid speculative micro-optimization.",
				keywords: [
					"state",
					"store",
					"effect",
					"useeffect",
					"subscription",
					"async",
					"fetch",
					"query",
					"navigation",
					"lifecycle",
					"cache",
				],
				paths: ["store", "hook", "context", "query"],
				model: "sonnet",
				effort: "high",
			}),
		],
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
			"webhook",
		],
		instructions: `You work on server-side logic.
- Follow the existing service boundaries, module layout and error-handling conventions.
- Validate input at the boundary; never trust client data.
- Enforce authentication and authorization where data is read or changed, not only in the UI.
- Keep data consistent: transactions where several writes must succeed together.
- Handle partial failure; make retried operations (jobs, webhooks, queues) idempotent; watch concurrency.
- Return errors in the project's established shapes.
- Add or update API and integration tests for changed behaviour.`,
		roles: roles({
			planner: [
				"opus",
				"high",
				"Cover validation, authorization, transactions, failure handling, idempotency and concurrency for the change, and the tests that prove them.",
			],
			architect: [
				"fable",
				"high",
				"Decide service boundaries, data ownership and consistency strategy when the change crosses services or needs a new pattern.",
			],
			implementer: [
				"sonnet",
				"medium",
				"Implement in the existing service style; validate input, check authorization, and keep writes consistent.",
			],
			reviewer: [
				"opus",
				"high",
				"Check validation, authorization, transactions and consistency, partial failure, idempotency, retries, concurrency and missing tests.",
			],
			quick: [
				"haiku",
				"medium",
				`${SHORT} Never for authentication, authorization, data handling or transactions, however short.`,
			],
		}),
		customRoles: [
			reviewer({
				id: "backend-api-contract-reviewer",
				name: "API Contract Reviewer",
				description:
					"Checks changed endpoints and shared types for contract problems.",
				instructions:
					"Review only changed endpoints, externally consumed types, messages and service contracts: request and response shapes, compatibility for existing consumers, validation, error semantics, authorization, and which consumers or docs must change. Do not repeat a general implementation review.",
				keywords: [
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
					"webhook",
					"message",
				],
				paths: [
					"routes",
					"router",
					"api/",
					"controller",
					"schema",
					"contract",
					"proto",
				],
				model: "sonnet",
				effort: "high",
			}),
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
			"pagination",
			"rate limit",
			"versioning",
		],
		instructions: `You design and change APIs.
- Treat the contract as the product: shapes, status codes, error semantics, defaults and optionality are deliberate.
- Keep changes backward compatible unless the task says otherwise; version or deprecate instead of breaking.
- Validate requests and responses with the project's schema tooling.
- Require the right authentication and authorization for every operation.
- Where relevant, define pagination, rate-limit behaviour, and webhook retries with idempotency.
- Update documentation and consumers affected by the change.`,
		roles: roles({
			planner: [
				"opus",
				"high",
				"Specify the contract change, compatibility for existing consumers, validation, auth, pagination or rate behaviour, and docs to update.",
			],
			architect: [
				"fable",
				"high",
				"Decide versioning, deprecation and contract shape when a change would break or fork existing consumers.",
			],
			implementer: [
				"sonnet",
				"medium",
				"Implement the contract exactly as specified, with schema validation and auth; update docs and examples.",
			],
			reviewer: [
				"opus",
				"high",
				"Check the contract against the plan: compatibility, validation, auth, error semantics, pagination and documentation.",
			],
			quick: [
				"haiku",
				"medium",
				`${SHORT} Typical: a doc string or an example; never a contract change.`,
			],
		}),
		customRoles: [
			reviewer({
				id: "api-contract-compatibility-reviewer",
				name: "Contract Compatibility Reviewer",
				description:
					"Compares old and new API behaviour for existing consumers.",
				instructions:
					"When an existing contract changes or a new public one is added: compare old and new behaviour, list affected consumers, and check error behaviour, optionality, defaults and compatibility assumptions. Suggest focused contract tests for anything not covered.",
				keywords: [
					"api",
					"endpoint",
					"contract",
					"breaking",
					"version",
					"deprecat",
					"public",
					"schema",
					"openapi",
				],
				paths: ["openapi", "schema", "contract", "routes", "router", "api/"],
				model: "sonnet",
				effort: "high",
			}),
		],
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
			"backfill",
			"transaction",
		],
		instructions: `You work on stored data.
- Protect integrity first: constraints, relations, nullability and defaults.
- Write queries that are correct, then efficient; check indexes for new access patterns.
- Think about existing rows: backfills, defaults, compatibility while old and new code run together.
- Consider locking and reversibility of every migration.
- Follow this repository's migration rules exactly (for example generated migration files that must not be edited, or migrations only the user runs).
- Never run operations against a shared or production database.`,
		roles: roles({
			planner: [
				"opus",
				"high",
				"Plan schema and migration steps, the effect on existing rows, backfills, indexes, rollout compatibility and the repository's migration rules.",
			],
			architect: [
				"fable",
				"high",
				"Decide data modelling and migration strategy for risky changes: destructive steps, large backfills, transaction boundaries.",
			],
			implementer: [
				"sonnet",
				"high",
				"Implement schema and query changes following the repository's migration rules; never edit generated migration files by hand when the rules forbid it.",
			],
			reviewer: [
				"opus",
				"high",
				"Check integrity, query correctness, indexes, existing-row behaviour, locking and reversibility.",
			],
			quick: [
				"haiku",
				"medium",
				`${SHORT} Only for wording, comments or formatting; never schema, migrations or queries that change data.`,
			],
		}),
		customRoles: [
			reviewer({
				id: "database-migration-reviewer",
				name: "Migration Safety Reviewer",
				description:
					"Checks schema changes and migrations for data loss and unsafe rollout.",
				instructions:
					"Review schema changes, migrations, backfills, destructive operations and substantial transaction changes: existing-row behaviour, data loss, compatibility during rollout, locking, nullability, defaults, backfills and recovery. Follow the project's migration rules. Do not execute anything against a database, and do not invent table sizes or lock timings.",
				keywords: [
					"migration",
					"schema",
					"column",
					"table",
					"index",
					"alter",
					"drop",
					"backfill",
					"drizzle",
					"prisma",
					"transaction",
				],
				paths: ["migration", "schema", ".sql", "drizzle", "prisma"],
				model: "opus",
				effort: "high",
			}),
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
			"mock",
			"fixture",
		],
		instructions: `You make sure work is verifiably done.
- Turn the request into observable acceptance criteria.
- Reproduce a bug with a failing test before fixing it, where practical.
- Choose the smallest set of tests that proves the criteria, in the project's test style; keep them isolated and deterministic.
- Assert behaviour, not implementation details; cover negative paths.
- Diagnose failures from their output instead of retrying blindly.
- Never write tests only to raise a count. Report which commands actually ran.`,
		roles: roles({
			planner: [
				"opus",
				"medium",
				"Write observable acceptance criteria and the test or command that proves each; plan reproduction first for bugs.",
			],
			architect: [
				"fable",
				"high",
				"Decide test infrastructure changes (fixtures, fakes, isolation) when existing tooling cannot support the needed tests.",
			],
			implementer: [
				"sonnet",
				"medium",
				"Write focused, deterministic tests with meaningful assertions, then the fix; keep mocks scoped.",
			],
			reviewer: [
				"opus",
				"medium",
				"Check that each criterion is proved by a test that actually ran, and that the tests would fail without the change.",
			],
			quick: [
				"haiku",
				"medium",
				`${SHORT} Typical: renaming a test or fixing an assertion message.`,
			],
		}),
		customRoles: [
			reviewer({
				id: "qa-test-quality-reviewer",
				name: "Test Quality Reviewer",
				description:
					"Checks whether new or changed tests would catch the defect.",
				instructions:
					"For substantial new tests, changed mocks, flaky-test fixes or test infrastructure: decide whether the tests would catch the intended defect. Look for false positives, leaked or global mocks, assertions that mirror the implementation, missing negative paths, timing dependence, and accidental real network or model access. Separate tests that ran from tests that are only proposed.",
				keywords: [
					"test",
					"tests",
					"mock",
					"flaky",
					"fixture",
					"e2e",
					"coverage",
				],
				paths: [".test.", ".spec.", "__tests__", "fixtures", "mocks"],
				model: "sonnet",
				effort: "high",
			}),
		],
	},
	{
		id: "security",
		builtIn: true,
		name: "Security",
		specialty: "Security",
		keywords: [
			"security",
			"auth",
			"login",
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
			"session",
			"credential",
		],
		instructions: `You work on security-sensitive code.
- Identify the assets and trust boundaries the change crosses: user input, network, filesystem, other processes.
- Check authentication and authorization on every changed operation.
- Keep secrets out of code, logs, URLs and error messages.
- Validate and encode input; never build shell commands or queries by string interpolation.
- Constrain file access and command execution to what the feature needs.
- Handle sessions and tokens safely (lifetime, storage, revocation); avoid exposing sensitive data.
- Consider dependency and integration risks the change introduces.`,
		roles: roles({
			planner: [
				"opus",
				"high",
				"Identify assets, trust boundaries and abuse cases for the change, and the mitigations the plan must include.",
			],
			architect: [
				"fable",
				"high",
				"Decide trust-boundary and authorization design for the change; prefer established mechanisms over custom crypto or auth.",
			],
			implementer: [
				"sonnet",
				"high",
				"Implement with the mitigations from the plan; validate input, check authorization, and keep secrets out of logs.",
			],
			reviewer: [
				"opus",
				"high",
				"Independently check authorization, secret exposure, injection, unsafe file or command execution, and session/token handling in the changes.",
			],
			quick: [
				"haiku",
				"medium",
				`${SHORT} Only for wording or formatting; never authentication, permissions, secrets or input handling.`,
			],
		}),
		customRoles: [
			reviewer({
				id: "security-threat-modeler",
				name: "Threat Modeler",
				description:
					"Lists realistic threats and required mitigations before a sensitive change.",
				instructions:
					"Before implementation of a meaningful change to authentication, authorization, secret handling, uploads, remote input, process execution or privileged boundaries: identify realistic actors, assets, entry points and abuse cases, and the mitigations the implementation must include. Keep it scoped to this change; no generic checklists. Do not run scans or attack anything.",
				keywords: [
					"auth",
					"login",
					"token",
					"secret",
					"permission",
					"role",
					"upload",
					"exec",
					"shell",
					"password",
					"encrypt",
					"session",
					"credential",
					"admin",
				],
				trigger: "before-implementation",
				expectedOutput:
					"A short threat list (actor, entry point, abuse case, required mitigation), then `VERDICT: PASS` if the task and plan cover the mitigations or `VERDICT: FAIL` if something essential is missing.",
				model: "opus",
				effort: "high",
			}),
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
			"packaging",
		],
		instructions: `You work on build, release and operations.
- Follow the project's existing CI and build conventions.
- Keep builds reproducible: pinned versions, deterministic steps.
- Keep environments separate and their configuration explicit.
- Reference secrets through the platform's secret store; never print or commit them.
- Make failures visible and recoverable; plan rollback.
- Prepare configuration only: never publish, deploy, install or change infrastructure as part of a task.`,
		roles: roles({
			planner: [
				"opus",
				"high",
				"Identify affected pipelines, environments, secrets, artifacts and the rollback path.",
			],
			architect: [
				"fable",
				"high",
				"Decide pipeline or infrastructure structure when environments, permissions or release flow change.",
			],
			implementer: [
				"sonnet",
				"high",
				"Change configuration in the project's conventions; keep steps reproducible and secrets in the secret store.",
			],
			reviewer: [
				"opus",
				"high",
				"Check reproducibility, environment targeting, secret handling, failure visibility and rollback.",
			],
			quick: [
				"haiku",
				"medium",
				`${SHORT} Typical: a version bump or a comment; never permissions, secrets or deploy targets.`,
			],
		}),
		customRoles: [
			reviewer({
				id: "devops-release-safety-reviewer",
				name: "Release Safety Reviewer",
				description:
					"Checks release, infrastructure and credentials changes before they ship.",
				instructions:
					"Review changed release pipelines, infrastructure definitions, credential handling, packaging or deployment configuration: permissions, environment targeting, destructive steps, reproducibility, failure handling and recovery. Distinguish preparing a configuration from executing it. Never publish, deploy, install or change infrastructure.",
				keywords: [
					"release",
					"deploy",
					"pipeline",
					"infra",
					"terraform",
					"credential",
					"secret",
					"packag",
					"publish",
					"workflow",
				],
				paths: [
					".github/workflows",
					"terraform",
					"docker",
					"helm",
					"deploy",
					"release",
					"electron-builder",
				],
				model: "sonnet",
				effort: "high",
			}),
		],
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
			"throughput",
		],
		instructions: `You improve performance with evidence.
- Work on one specific, observed problem.
- Measure a credible baseline on a representative workload before changing code.
- Keep correctness: compare behaviour before and after.
- Prefer the simplest change that removes the measured cost; no speculative optimization.
- Repeat measurements and check other paths for regressions. Never invent numbers.`,
		roles: roles({
			planner: [
				"opus",
				"high",
				"Define the metric, workload, baseline method, success threshold and how correctness is preserved.",
			],
			architect: [
				"fable",
				"high",
				"Decide structural changes (caching layers, data structures, concurrency) when measurements show the design is the bottleneck.",
			],
			implementer: [
				"sonnet",
				"high",
				"Make the change the measurements justify; keep it minimal and keep behaviour identical.",
			],
			reviewer: [
				"opus",
				"high",
				"Check correctness and that the claimed improvement is backed by before/after measurements.",
			],
			quick: [
				"haiku",
				"medium",
				`${SHORT} Typical: a tunable constant the measurements already justify.`,
			],
		}),
		customRoles: [
			reviewer({
				id: "performance-measurement-analyst",
				name: "Measurement Analyst",
				description:
					"Defines how a performance problem is measured before optimizing.",
				instructions:
					"Before an optimization: define the metric, a representative workload, the baseline, the measurement method and the success threshold, and analyse any existing profiles. ADE runs approved local measurement commands through its checks; do not invent timings, claim a speedup without evidence, or start paid benchmarks or external load tests.",
				keywords: [
					"slow",
					"performance",
					"latency",
					"optimiz",
					"memory",
					"cpu",
					"profil",
					"benchmark",
					"throughput",
				],
				trigger: "before-implementation",
				expectedOutput:
					"The metric, workload, baseline and method, success threshold, and what evidence exists; then `VERDICT: PASS` if there is enough to proceed or `VERDICT: FAIL` if measurements are needed first.",
				model: "sonnet",
				effort: "high",
			}),
		],
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
			"tutorial",
			"example",
		],
		instructions: `You write documentation.
- Describe what the code does now; read it before documenting it.
- Write clear steps a new reader can follow, with correct terminology.
- Keep examples correct and runnable against the current interfaces.
- Match the existing documentation's structure, tone and level of detail.
- Never claim support for something the code does not do.`,
		roles: roles({
			planner: [
				"opus",
				"low",
				"Identify the pages, sections and examples to change and the code they describe.",
			],
			architect: [
				"opus",
				"medium",
				"Decide documentation structure (new pages, reorganization) when content no longer fits the existing layout.",
			],
			implementer: [
				"sonnet",
				"medium",
				"Write accurate, specific documentation in the existing style; verify each statement against the code.",
			],
			reviewer: [
				"sonnet",
				"high",
				"Check accuracy against the code, clarity of steps, terminology and unsupported claims.",
			],
			quick: [
				"haiku",
				"medium",
				`${SHORT} Typical: spelling, grammar or a broken link.`,
			],
		}),
		customRoles: [
			reviewer({
				id: "documentation-example-reviewer",
				name: "Example Accuracy Reviewer",
				description:
					"Checks commands and code examples against the real interfaces.",
				instructions:
					"For changed commands, code examples, installation steps, configuration examples or API documentation: check them against the actual interfaces and supported versions. Flag wrong commands, missing prerequisites, stale options and unsupported claims. Do not run commands copied from documentation; ADE runs only approved checks.",
				keywords: [
					"example",
					"command",
					"install",
					"setup",
					"config",
					"api doc",
					"snippet",
					"usage",
					"cli",
				],
				model: "sonnet",
				effort: "medium",
			}),
		],
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
			"push notification",
			"offline",
		],
		instructions: `You build mobile app features.
- Follow platform conventions for navigation, gestures and system UI.
- Handle the lifecycle: backgrounding, resume, interruption and restoration.
- Request permissions only when needed and handle denial.
- Respect device constraints: small screens, battery, flaky or offline networks.
- Provide accessible touch targets and screen-reader labels.
- Use the project's framework conventions (Expo, React Native, native modules) instead of new libraries.`,
		roles: roles({
			planner: [
				"opus",
				"medium",
				"Cover navigation, lifecycle, permissions, offline behaviour and platform differences for the change.",
			],
			architect: [
				"fable",
				"high",
				"Decide navigation structure, persistence and background-work strategy when they change across platforms.",
			],
			implementer: [
				"sonnet",
				"medium",
				"Implement in the project's framework conventions; handle lifecycle, permissions and offline states.",
			],
			reviewer: [
				"opus",
				"medium",
				"Check lifecycle handling, permissions, offline and error states, platform conventions and accessibility.",
			],
			quick: [
				"haiku",
				"medium",
				`${SHORT} Typical: a string, a style value or an icon.`,
			],
		}),
		customRoles: [
			reviewer({
				id: "mobile-lifecycle-reviewer",
				name: "Mobile Lifecycle Reviewer",
				description:
					"Checks lifecycle, permissions, persistence and offline behaviour.",
				instructions:
					"For changes to lifecycle, navigation, permissions, persistence, background work or offline behaviour: check interruption, restoration, cancellation, platform differences and device-specific assumptions. State which platforms and devices were actually tested; unit tests are not device testing.",
				keywords: [
					"lifecycle",
					"background",
					"resume",
					"permission",
					"offline",
					"persist",
					"navigation",
					"push",
					"notification",
				],
				model: "sonnet",
				effort: "high",
			}),
		],
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
			"preload",
			"main process",
		],
		instructions: `You build desktop application features.
- Keep privileged work in the main process; expose only what is needed over IPC, and validate every IPC input.
- Handle the application lifecycle: windows closing, quitting, single instance and restarts.
- Treat filesystem access carefully: user paths, permissions, Windows and macOS path differences.
- Launch processes without shell interpolation and clean them up.
- Keep packaging working: native modules and paths inside the packaged app.
- Follow the project's Electron and IPC conventions.`,
		roles: roles({
			planner: [
				"opus",
				"high",
				"Map the process boundaries, IPC calls, filesystem access, lifecycle effects and packaging impact of the change.",
			],
			architect: [
				"fable",
				"high",
				"Decide process and privilege boundaries when new capabilities cross renderer and main.",
			],
			implementer: [
				"sonnet",
				"medium",
				"Implement with validated IPC and the project's conventions; handle paths cross-platform.",
			],
			reviewer: [
				"opus",
				"medium",
				"Check IPC validation, privilege boundaries, lifecycle, cross-platform paths and packaging.",
			],
			quick: [
				"haiku",
				"medium",
				`${SHORT} Typical: a label, a menu text or a style; never IPC or filesystem code.`,
			],
		}),
		customRoles: [
			reviewer({
				id: "desktop-ipc-reviewer",
				name: "IPC and Privilege Reviewer",
				description:
					"Checks changes that cross renderer/main or other privilege boundaries.",
				instructions:
					"For changes crossing renderer/main, process, filesystem or local-server boundaries: check input validation, authorization, exposed capabilities, process launching, path handling and cleanup, following the project's Electron/IPC conventions. Say when a trust-boundary question needs escalation. Skip harmless label changes.",
				keywords: [
					"ipc",
					"preload",
					"main process",
					"filesystem",
					"spawn",
					"exec",
					"local server",
					"privilege",
					"trpc",
					"electron",
				],
				paths: [
					"preload",
					"/main/",
					"ipc",
					"trpc/routers",
					"local-server",
					"electron",
				],
				model: "sonnet",
				effort: "high",
			}),
		],
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
			"roblox",
			"player",
			"level",
			"physics",
			"input",
			"shader",
			"blueprint",
			"multiplayer",
		],
		instructions: `You work on games.
- Identify the engine and language from the project (Unreal C++/Blueprints, Unity C#, Godot GDScript, Roblox Luau…) and follow its conventions.
- Keep gameplay state and input handling predictable and frame-rate independent.
- Respect per-frame performance budgets; avoid work in hot loops.
- For multiplayer, respect server authority and synchronization.
- Describe concrete play-test steps for every gameplay change.`,
		roles: roles({
			planner: [
				"opus",
				"high",
				"Identify the engine-specific approach, gameplay state, input, timing, performance budget, networking authority and play-test steps.",
			],
			architect: [
				"fable",
				"high",
				"Decide gameplay system structure and authority model when systems interact or replicate.",
			],
			implementer: [
				"sonnet",
				"medium",
				"Implement in the engine's conventions; keep logic frame-rate independent.",
			],
			reviewer: [
				"opus",
				"medium",
				"Check frame-rate independence, per-frame cost, engine conventions and play-test steps.",
			],
			quick: [
				"haiku",
				"medium",
				`${SHORT} Typical: a tuning value or a UI string.`,
			],
		}),
		customRoles: [
			reviewer({
				id: "gamedev-gameplay-reviewer",
				name: "Gameplay Systems Reviewer",
				description: "Checks gameplay state, timing and input changes.",
				instructions:
					"For movement, input, combat, abilities, physics, gameplay state or replicated behaviour: check timing, state transitions, interruptions, frame-rate dependence, input edge cases and interactions with existing systems; for multiplayer, authority and synchronization. Give concrete play-test scenarios. Never claim a play-test happened without evidence.",
				keywords: [
					"gameplay",
					"player",
					"input",
					"physics",
					"ability",
					"combat",
					"movement",
					"replicat",
					"multiplayer",
					"spawn",
				],
				model: "sonnet",
				effort: "high",
			}),
		],
	},
];
