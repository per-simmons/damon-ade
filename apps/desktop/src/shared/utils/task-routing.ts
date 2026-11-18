/**
 * Decides how a coding task described in ADE is run, without calling a model
 * (planning a simple task would cost more than doing it).
 *
 * Routes, cheapest first:
 * - quick:       one Haiku session makes a small, fully specified change.
 * - implement:   one Sonnet session implements directly, then a Sonnet
 *                reviewer checks it. No planning call.
 * - plan:        Opus writes a plan, Sonnet builds it step by step, a Sonnet
 *                reviewer checks it; blocked steps escalate to Fable.
 * - exceptional: like plan, but Fable writes the plan. Only chosen by the user.
 *
 * The rules are deliberately simple and explainable; the user can always
 * override the route.
 */

export const TASK_ROUTES = [
	"quick",
	"implement",
	"plan",
	"exceptional",
] as const;
export type TaskRoute = (typeof TASK_ROUTES)[number];

export interface RouteDecision {
	route: Exclude<TaskRoute, "exceptional">;
	reasons: string[];
}

const COMPLEX_TERMS = [
	"architecture",
	"architect",
	"redesign",
	"design",
	"refactor",
	"migrate",
	"migration",
	"rewrite",
	"overhaul",
	"integrate",
	"integration",
	"orchestrat",
	"across",
	"end-to-end",
	"end to end",
	"performance",
	"optimiz",
	"optimis",
	"concurren",
	"race condition",
	"deadlock",
	"memory leak",
	"security",
	"authentication",
	"authorization",
	"schema",
	"database",
	"protocol",
	"framework",
	"scalab",
	"multi-",
	"system",
];

const SIMPLE_TERMS = [
	"typo",
	"rename",
	"spelling",
	"comment",
	"docs",
	"readme",
	"format",
	"lint",
	"bump",
	"version",
	"wording",
	"label",
	"copy text",
	"log message",
	"whitespace",
	"small",
	"tiny",
	"minor",
	"one-line",
	"one line",
];

/** Things that look like file paths or file names: a/b, x.ts, ./y. */
const FILE_REFERENCE =
	/(?:^|[\s`'"(])(?:\.{0,2}\/)?[\w@-]+(?:\/[\w@.-]+)+|\b[\w-]+\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|rb|php|cs|swift|css|scss|html|json|ya?ml|toml|md|sql|sh)\b/g;

function matchedTerms(text: string, terms: string[]): string[] {
	return terms.filter((term) =>
		term.includes(" ") || term.endsWith("-")
			? text.includes(term)
			: new RegExp(`\\b${term}`).test(text),
	);
}

export function classifyTask(description: string): RouteDecision {
	const text = description.toLowerCase();
	const words = text.split(/\s+/).filter(Boolean).length;
	const files = new Set(
		[...description.matchAll(FILE_REFERENCE)].map((match) => match[0].trim()),
	).size;
	const complex = matchedTerms(text, COMPLEX_TERMS);
	const simple = matchedTerms(text, SIMPLE_TERMS);

	if (complex.length >= 2) {
		return {
			route: "plan",
			reasons: [`mentions ${complex.slice(0, 3).join(", ")}`],
		};
	}
	if (complex.length === 1 && (words > 25 || files >= 2)) {
		return {
			route: "plan",
			reasons: [
				`mentions ${complex[0]}`,
				files >= 2 ? `${files} files` : `${words} words`,
			],
		};
	}
	if (words > 120) {
		return { route: "plan", reasons: [`long description (${words} words)`] };
	}
	if (files >= 4) {
		return { route: "plan", reasons: [`${files} files mentioned`] };
	}
	if (simple.length > 0 && complex.length === 0 && words <= 30 && files <= 1) {
		return {
			route: "quick",
			reasons: [`small change (${simple.slice(0, 2).join(", ")})`],
		};
	}
	return {
		route: "implement",
		reasons:
			complex.length > 0
				? [`mentions ${complex[0]}, but short and focused`]
				: ["a focused change that needs no plan"],
	};
}

/** Short kebab-case slug for a task, unique against `existing`. */
export function slugForTask(
	description: string,
	existing: Set<string>,
): string {
	const base =
		description
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, " ")
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 6)
			.join("-")
			.slice(0, 48)
			.replace(/-+$/, "") || "task";
	let slug = base;
	for (let n = 2; existing.has(slug); n++) slug = `${base}-${n}`;
	return slug;
}
