import { Button } from "@superset/ui/button";
import { cn } from "@superset/ui/utils";
import { LuTerminal } from "react-icons/lu";
import { RUN_LABELS } from "../../../../../../constants";
import type { RunView } from "../../../../../../types";
import { runCostLabel } from "../../../../../../utils/costLabel";
import { RunStatusIcon } from "./components/RunStatusIcon";

interface RunRowProps {
	run: RunView;
	onOpenSession?: () => void;
}

/** One run of a task: what ran, on which model, how it ended, what it cost. */
export function RunRow({ run, onOpenSession }: RunRowProps) {
	const observed = run.observedModels.filter((model) => model !== run.model);
	const cost = runCostLabel(run);
	const failedChecks = (run.checks ?? []).filter(
		(check) => check.exitCode !== 0 || check.timedOut,
	);
	return (
		<li
			className={cn(
				"group rounded-md px-2 py-1.5 text-xs hover:bg-muted/40",
				run.history && "opacity-60",
			)}
			data-run-kind={run.kind}
		>
			<div className="flex items-start gap-2">
				<span className="mt-px" title={run.status}>
					<RunStatusIcon status={run.status} />
				</span>
				<div className="min-w-0 flex-1 space-y-0.5">
					<div className="flex flex-wrap items-center gap-x-2">
						<span className="font-medium">
							{run.kind === "custom" && run.role
								? run.role
								: RUN_LABELS[run.kind]}
							{run.attempt > 1 ? ` #${run.attempt}` : ""}
						</span>
						{run.verdict && (
							<span
								className={cn(
									"rounded px-1 font-medium",
									run.verdict === "PASS"
										? "bg-emerald-500/10 text-emerald-600"
										: "bg-destructive/10 text-destructive",
								)}
							>
								{run.verdict}
							</span>
						)}
						{run.checks &&
							(failedChecks.length === 0 ? (
								<span className="text-emerald-600">checks passed</span>
							) : (
								<span className="text-destructive">
									failed:{" "}
									{failedChecks.map((check) => check.command).join(", ")}
								</span>
							))}
						{run.history && (
							<span
								className="text-muted-foreground"
								title="Before the task was moved: kept as history, not as evidence"
							>
								(history)
							</span>
						)}
						{cost && (
							<span className="ml-auto tabular-nums text-muted-foreground">
								{cost}
							</span>
						)}
					</div>
					<div className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
						<span className="sr-only">{run.status}</span>
						{run.role && run.kind !== "custom" && (
							<span>
								{run.role}
								{run.specialist ? ` (${run.specialist})` : ""}
							</span>
						)}
						{run.model && (
							<span>
								on {run.model}
								{observed.length > 0
									? ` (reported ${observed.join(", ")})`
									: ""}
							</span>
						)}
						{run.effort && (
							<span
								title={
									run.effortNote ??
									"The effort ADE requested; Claude Code does not report the effective effort back"
								}
							>
								effort {run.effort} (requested)
								{run.effortNote ? " · overridden by the environment" : ""}
							</span>
						)}
						{run.fallbackFrom && (
							<span className="text-amber-600">
								cheaper retry of {run.fallbackFrom}
							</span>
						)}
						{onOpenSession && (
							<Button
								size="sm"
								variant="link"
								className="h-auto gap-1 p-0 text-xs text-muted-foreground opacity-80 hover:text-foreground group-hover:opacity-100"
								title="Opens the run's Claude session in a terminal. That session is interactive: ADE's permission profile, budget and turn limits do not apply to it."
								onClick={onOpenSession}
							>
								<LuTerminal className="size-3" aria-hidden />
								Open session in terminal
							</Button>
						)}
					</div>
					{run.error && (
						<p className="break-words text-destructive">
							{run.failure ? `${run.failure}: ` : ""}
							{run.error.slice(0, 300)}
						</p>
					)}
				</div>
			</div>
		</li>
	);
}
