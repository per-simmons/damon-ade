import type { ElectronRouterOutputs } from "renderer/lib/electron-trpc";

export type HistoryOverview =
	ElectronRouterOutputs["projectHistory"]["overview"];
export type HistoryProjectInfo = HistoryOverview["project"];
export type ImportedConversation = HistoryOverview["conversations"][number];
export type SessionList =
	ElectronRouterOutputs["projectHistory"]["listSessions"];
export type SessionItem = SessionList["sessions"][number];
export type ExportPreview =
	ElectronRouterOutputs["projectHistory"]["previewExport"];
export type HistoryScope = "project" | "worktree";
