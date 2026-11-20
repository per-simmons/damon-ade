import type { ElectronRouterOutputs } from "renderer/lib/electron-trpc";

export type SpecialistList = ElectronRouterOutputs["specialists"]["list"];
export type SpecialistView = SpecialistList["specialists"][number];
export type TemplateView =
	ElectronRouterOutputs["specialists"]["templates"][number];
export type ModelCatalog = ElectronRouterOutputs["specialists"]["models"];
export type RoleName = SpecialistList["baseRoles"][number]["role"];
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface RoleDraft {
	model?: string;
	effort?: EffortLevel;
	maxTurns?: number;
	instructions?: string;
}

export interface CustomRoleDraft {
	id: string;
	name: string;
	description: string;
	instructions: string;
	access: "read-only" | "edit";
	trigger: "before-implementation" | "after-implementation" | "on-request";
	keywords: string[];
	expectedOutput: string;
	model?: string;
	effort?: EffortLevel;
	maxTurns?: number;
}

export interface SpecialistDraft {
	id?: string;
	name: string;
	specialty: string;
	templateId?: string;
	templateUses: { instructions: boolean; models: boolean };
	instructions?: string;
	keywords?: string[];
	roles: Partial<Record<RoleName, RoleDraft>>;
	customRoles: CustomRoleDraft[];
	disabledTemplateRoles: string[];
}

export const SOURCE_LABELS: Record<string, string> = {
	global: "global default",
	template: "from template",
	specialist: "customized for this specialist",
	task: "overridden for this task",
};

export const TRIGGER_LABELS: Record<CustomRoleDraft["trigger"], string> = {
	"before-implementation": "Before implementation",
	"after-implementation": "After implementation and checks",
	"on-request": "Only when I run it (Manual)",
};
