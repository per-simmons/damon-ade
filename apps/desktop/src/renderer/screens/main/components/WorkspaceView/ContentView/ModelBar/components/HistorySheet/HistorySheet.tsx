import { Button } from "@superset/ui/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@superset/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@superset/ui/tabs";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { ExportImport } from "./components/ExportImport";
import { ImportedList } from "./components/ImportedList";
import { RepositoryCard } from "./components/RepositoryCard";
import { SessionImport } from "./components/SessionImport";
import { TranscriptImport } from "./components/TranscriptImport";

interface HistorySheetProps {
	workspaceId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** Open the Tasks panel to describe a task that uses this history. */
	onStartTask: () => void;
}

/**
 * Project history: link earlier conversations to this repository, then
 * start tasks that draw on them. The flow is: check the repository, choose a
 * source, pick the conversations, confirm the association, start a task.
 */
export function HistorySheet({
	workspaceId,
	open,
	onOpenChange,
	onStartTask,
}: HistorySheetProps) {
	const utils = electronTrpc.useUtils();
	const { data, error } = electronTrpc.projectHistory.overview.useQuery(
		{ workspaceId },
		{ enabled: open },
	);
	const changed = () => {
		void utils.projectHistory.invalidate();
		void utils.workflow.getProjectTasks.invalidate({ workspaceId });
	};

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent className="w-[560px] overflow-y-auto sm:max-w-[560px]">
				<SheetHeader>
					<SheetTitle>
						History{data ? ` · ${data.project.name}` : ""}
					</SheetTitle>
					<SheetDescription>
						Link earlier Claude conversations to this repository. Tasks then get
						the relevant excerpts as historical context; the repository stays
						the authority on what is implemented.
					</SheetDescription>
				</SheetHeader>
				<div className="space-y-5 px-4 pb-6" data-panel="history">
					{error && <p className="text-xs text-destructive">{error.message}</p>}
					{data && (
						<>
							<RepositoryCard project={data.project} />

							<section className="space-y-2">
								<h3 className="text-sm font-medium">Add conversations</h3>
								<Tabs defaultValue="sessions">
									<TabsList>
										<TabsTrigger value="sessions">
											Claude Code sessions
										</TabsTrigger>
										<TabsTrigger value="export">Claude app export</TabsTrigger>
										<TabsTrigger value="transcript">
											Transcript file
										</TabsTrigger>
									</TabsList>
									<TabsContent value="sessions" className="pt-2">
										<SessionImport
											workspaceId={workspaceId}
											project={data.project}
											onImported={changed}
										/>
									</TabsContent>
									<TabsContent value="export" className="pt-2">
										<ExportImport
											workspaceId={workspaceId}
											project={data.project}
											onImported={changed}
										/>
									</TabsContent>
									<TabsContent value="transcript" className="pt-2">
										<TranscriptImport
											workspaceId={workspaceId}
											project={data.project}
											onImported={changed}
										/>
									</TabsContent>
								</Tabs>
							</section>

							<section className="space-y-2">
								<div className="flex items-center justify-between gap-2">
									<h3 className="text-sm font-medium">
										Linked to this project
									</h3>
									<Button
										size="sm"
										disabled={data.conversations.length === 0}
										onClick={onStartTask}
									>
										Start a task
									</Button>
								</div>
								<ImportedList
									workspaceId={workspaceId}
									conversations={data.conversations}
									onChanged={changed}
									onStartTask={onStartTask}
								/>
							</section>
						</>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}
