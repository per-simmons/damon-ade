import {
	type AgentBinary,
	BINARY_INSTALL,
} from "@superset/shared/agent-binaries";
import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import { toast } from "@superset/ui/sonner";
import { useState } from "react";
import {
	HiArrowPath,
	HiOutlineArrowTopRightOnSquare,
	HiOutlineCheck,
	HiOutlineClipboard,
} from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";

interface BinaryInstallDialogProps {
	/** The missing binary to explain, or null when the dialog is closed. */
	binary: AgentBinary | null;
	onOpenChange: (open: boolean) => void;
	/** Re-probe availability (bypasses cache); wired to the "Re-check" button. */
	onRecheck?: () => void;
	/** True while a re-check probe is in flight. */
	isRechecking?: boolean;
}

/**
 * Explains why an agent CLI (or git) isn't runnable and how to install it: the
 * copy-paste command, a docs link, and a Re-check button that re-probes after
 * the user installs the tool in a terminal. Reused by the ModelBar not-detected
 * state and the NewAgentModal git preflight.
 */
export function BinaryInstallDialog({
	binary,
	onOpenChange,
	onRecheck,
	isRechecking,
}: BinaryInstallDialogProps) {
	const openUrl = electronTrpc.external.openUrl.useMutation();
	const [copied, setCopied] = useState(false);

	const info = binary ? BINARY_INSTALL[binary] : null;

	const handleCopy = async () => {
		if (!info) return;
		try {
			await navigator.clipboard.writeText(info.command);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			toast.error("Could not copy to clipboard");
		}
	};

	return (
		<Dialog open={binary !== null} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[460px]">
				<DialogHeader>
					<DialogTitle>
						{info ? `Install ${info.label}` : "Install"}
					</DialogTitle>
					<DialogDescription>
						{info?.label ?? "This tool"} isn't installed on this machine. Run
						the command below in a terminal, then re-check.
					</DialogDescription>
				</DialogHeader>

				{info && (
					<div className="flex flex-col gap-3 py-1">
						<div className="flex items-stretch gap-2">
							<code className="flex-1 select-all rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs leading-relaxed break-all">
								{info.command}
							</code>
							<Button
								variant="outline"
								size="icon"
								aria-label="Copy command"
								onClick={handleCopy}
							>
								{copied ? (
									<HiOutlineCheck className="h-4 w-4" />
								) : (
									<HiOutlineClipboard className="h-4 w-4" />
								)}
							</Button>
						</div>
						{info.note && (
							<p className="text-xs text-muted-foreground">{info.note}</p>
						)}
						<button
							type="button"
							onClick={() => openUrl.mutate(info.url)}
							className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground hover:no-underline"
						>
							{info.url}
							<HiOutlineArrowTopRightOnSquare className="h-3 w-3" />
						</button>
					</div>
				)}

				<DialogFooter className="gap-2 sm:justify-between">
					{onRecheck ? (
						<Button
							variant="ghost"
							onClick={onRecheck}
							disabled={isRechecking}
							className="gap-1.5"
						>
							<HiArrowPath
								className={`h-4 w-4 ${isRechecking ? "animate-spin" : ""}`}
							/>
							{isRechecking ? "Checking…" : "Re-check"}
						</Button>
					) : (
						<span />
					)}
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Done
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
