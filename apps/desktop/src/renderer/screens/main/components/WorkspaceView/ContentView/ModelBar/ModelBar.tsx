import {
	type AgentBinary,
	type CheckedBinary,
	RUNTIME_BINARY,
} from "@superset/shared/agent-binaries";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { HiOutlinePlus } from "react-icons/hi2";
import {
	getPresetIcon,
	useIsDarkTheme,
} from "renderer/assets/app-icons/preset-icons";
import { BinaryInstallDialog } from "renderer/components/BinaryInstallDialog/BinaryInstallDialog";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useProviderKeys } from "renderer/stores/model-bar/useProviderKeys";
import { useRuntimeAvailability } from "renderer/stores/model-bar/useRuntimeAvailability";
import { useAgentSession } from "renderer/stores/tabs/useAgentSession";
import { type ModelDescriptor, MODEL_BAR_MODELS } from "./models";
import {
	ProviderKeyDialog,
	type ProviderKeyDialogMode,
} from "./ProviderKeyDialog";

/**
 * A quiet row of model logos below the session tab strip. Clicking a logo opens
 * a new session in the current agent's worktree running that model's CLI. The
 * OpenRouter-proxied models (Kimi / MiniMax / GLM) first gate on a stored
 * OpenRouter key; the trailing "+" manages that key.
 */
export function ModelBar() {
	const { workspaceId } = useParams({ strict: false });
	const isDark = useIsDarkTheme();
	const { spawnAgentSession } = useAgentSession();
	const { openrouterConfigured } = useProviderKeys();
	const { isAvailable, recheck, isFetching } = useRuntimeAvailability();

	const { data: workspace } = electronTrpc.workspaces.get.useQuery(
		{ id: workspaceId! },
		{ enabled: !!workspaceId },
	);

	const [dialog, setDialog] = useState<{
		mode: ProviderKeyDialogMode;
		model?: ModelDescriptor;
	} | null>(null);
	const [installBinary, setInstallBinary] = useState<AgentBinary | null>(null);

	// Close the install dialog once a re-check confirms the tool is now present.
	useEffect(() => {
		if (installBinary && isAvailable(installBinary as CheckedBinary)) {
			setInstallBinary(null);
		}
	}, [installBinary, isAvailable]);

	if (!workspaceId) return null;

	const worktreePath = workspace?.worktreePath ?? null;
	const ready = !!worktreePath;

	const spawn = (model: ModelDescriptor) => {
		void spawnAgentSession({
			id: workspaceId,
			runtime: model.runtime,
			worktreePath,
		});
	};

	const handleModelClick = (model: ModelDescriptor) => {
		if (!ready) return;
		// Availability gate comes first: every runtime (including the OpenRouter
		// ones, which drive the claude CLI) needs its binary present before we
		// bother prompting for a key or spawning.
		const binary = RUNTIME_BINARY[model.runtime];
		if (!isAvailable(binary as CheckedBinary)) {
			setInstallBinary(binary);
			return;
		}
		if (model.needsOpenRouterKey && openrouterConfigured !== true) {
			setDialog({ mode: "launch", model });
			return;
		}
		spawn(model);
	};

	return (
		<div className="flex h-9 shrink-0 items-center gap-0.5 border-b bg-background px-2">
			<div
				className={`flex items-center gap-0.5 ${
					ready ? "" : "pointer-events-none opacity-40"
				}`}
			>
				{MODEL_BAR_MODELS.map((model) => {
					const icon = getPresetIcon(model.iconName, isDark);
					const binary = RUNTIME_BINARY[model.runtime];
					const missing = !isAvailable(binary as CheckedBinary);
					return (
						<Tooltip key={model.runtime}>
							<TooltipTrigger asChild>
								<button
									type="button"
									aria-label={
										missing
											? `${model.label} — not detected, click to install`
											: `New session — ${model.label}`
									}
									disabled={!ready}
									onClick={() => handleModelClick(model)}
									className="group relative flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-muted"
								>
									{icon ? (
										<img
											src={icon}
											alt=""
											className={`h-4 w-4 object-contain transition-opacity group-hover:opacity-100 ${
												missing
													? "opacity-30 grayscale group-hover:opacity-60"
													: model.isDefault
														? "opacity-90"
														: "opacity-55"
											}`}
										/>
									) : (
										<span className="text-[10px] text-muted-foreground">
											{model.label.slice(0, 2)}
										</span>
									)}
									{model.isDefault && !missing && (
										<span className="absolute -bottom-px h-[3px] w-[3px] rounded-full bg-foreground/40" />
									)}
									{missing && (
										<span className="absolute -right-px -top-px h-[5px] w-[5px] rounded-full bg-amber-500 ring-1 ring-background" />
									)}
								</button>
							</TooltipTrigger>
							<TooltipContent side="bottom" showArrow={false}>
								{missing
									? `${model.label} not detected — click to install`
									: `${model.label}${model.isDefault ? " · default" : ""}`}
							</TooltipContent>
						</Tooltip>
					);
				})}
			</div>

			<div className="mx-1 h-4 w-px bg-border" />

			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						aria-label="Add provider"
						onClick={() => setDialog({ mode: "manage" })}
						className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
					>
						<HiOutlinePlus className="h-4 w-4" />
					</button>
				</TooltipTrigger>
				<TooltipContent side="bottom" showArrow={false}>
					Add provider
				</TooltipContent>
			</Tooltip>

			<ProviderKeyDialog
				open={dialog !== null}
				onOpenChange={(open) => !open && setDialog(null)}
				mode={dialog?.mode ?? "manage"}
				modelLabel={dialog?.model?.label}
				onSaved={() => {
					if (dialog?.model) spawn(dialog.model);
					setDialog(null);
				}}
			/>

			<BinaryInstallDialog
				binary={installBinary}
				onOpenChange={(open) => !open && setInstallBinary(null)}
				onRecheck={recheck}
				isRechecking={isFetching}
			/>
		</div>
	);
}
