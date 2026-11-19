import { Button } from "@superset/ui/button";
import { RUN_LABELS } from "../../../../../../constants";
import type { RunView } from "../../../../../../types";
import { runCostLabel } from "../../../../../../utils/costLabel";

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
		<li className="space-y-0.5 text-xs" data-run-kind={run.kind}>
			<div className="flex flex-wrap items-center gap-x-2">
				<span className="font-medium">
					{RUN_LABELS[run.kind]}
					{run.attempt > 1 ? ` #${run.attempt}` : ""}
				</span>
				<span className="text-muted-foreground">{run.status}</span>
				{run.model && (
					<span className="text-muted-foreground">
						on {run.model}
						{observed.length > 0 ? ` (reported ${observed.join(", ")})` : ""}
					</span>
				)}
				{run.fallbackFrom && (
					<span className="text-amber-600">
						cheaper retry of {run.fallbackFrom}
					</span>
				)}
				{run.verdict && (
					<span
						className={
							run.verdict === "PASS" ? "text-emerald-600" : "text-destructive"
						}
					>
						{run.verdict}
					</span>
				)}
				{run.checks &&
					(failedChecks.length === 0 ? (
						<span className="text-emerald-600">checks passed</span>
					) : (
						<span className="text-destructive">
							failed: {failedChecks.map((check) => check.command).join(", ")}
						</span>
					))}
				{cost && <span className="ml-auto text-muted-foreground">{cost}</span>}
			</div>
			{run.error && (
				<p className="break-words text-destructive">
					{run.failure ? `${run.failure}: ` : ""}
					{run.error.slice(0, 300)}
				</p>
			)}
			{onOpenSession && (
				<Button
					size="sm"
					variant="link"
					className="h-auto p-0 text-xs"
					title="Opens the run's Claude session in a terminal. That session is interactive: ADE's permission profile, budget and turn limits do not apply to it."
					onClick={onOpenSession}
				>
					Open session in terminal
				</Button>
			)}
		</li>
	);
}
