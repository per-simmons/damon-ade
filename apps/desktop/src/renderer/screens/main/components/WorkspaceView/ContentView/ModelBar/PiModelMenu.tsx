import { Popover, PopoverContent, PopoverTrigger } from "@superset/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { type ReactNode, useState } from "react";
import { HiOutlineCog6Tooth } from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { PiModelsDialog } from "./PiModelsDialog";

interface PiModelMenuProps {
	/** The ModelBar pi button; the popover + tooltip both anchor to it. */
	children: ReactNode;
	/** Spawn a pi session. No options = pi's own default model. */
	onLaunch: (options?: { commands: string[]; label: string }) => void;
}

/**
 * Model picker for the pi runtime. pi is multi-provider, so instead of one
 * launch per click the pi logo opens a menu: pi's default model, the user's
 * saved `--model` patterns, and a manage entry. Patterns are shell-inert by
 * validation (settings.setPiModels), so single-quoting them is safe.
 */
export function PiModelMenu({ children, onLaunch }: PiModelMenuProps) {
	const [open, setOpen] = useState(false);
	const [manageOpen, setManageOpen] = useState(false);
	const { data: models = [] } = electronTrpc.settings.getPiModels.useQuery();

	const launch = (pattern?: string) => {
		setOpen(false);
		if (!pattern) {
			onLaunch();
			return;
		}
		onLaunch({
			commands: [`pi --model '${pattern}'`],
			label: `pi · ${pattern}`,
		});
	};

	return (
		<>
			<Popover open={open} onOpenChange={setOpen}>
				<Tooltip>
					<TooltipTrigger asChild>
						<PopoverTrigger asChild>{children}</PopoverTrigger>
					</TooltipTrigger>
					<TooltipContent side="bottom" showArrow={false}>
						New pi session — pick a model
					</TooltipContent>
				</Tooltip>
				<PopoverContent align="start" className="w-56 p-1">
					<MenuRow label="pi — default model" onClick={() => launch()} />
					{models.length > 0 && <div className="my-1 h-px bg-border" />}
					{models.map((model) => (
						<MenuRow
							key={model}
							label={model}
							mono
							onClick={() => launch(model)}
						/>
					))}
					<div className="my-1 h-px bg-border" />
					<MenuRow
						label="Manage models…"
						icon={<HiOutlineCog6Tooth className="h-3.5 w-3.5" />}
						onClick={() => {
							setOpen(false);
							setManageOpen(true);
						}}
					/>
				</PopoverContent>
			</Popover>

			<PiModelsDialog open={manageOpen} onOpenChange={setManageOpen} />
		</>
	);
}

interface MenuRowProps {
	label: string;
	onClick: () => void;
	mono?: boolean;
	icon?: ReactNode;
}

function MenuRow({ label, onClick, mono, icon }: MenuRowProps) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted ${
				mono ? "font-mono text-[13px]" : ""
			}`}
		>
			{icon}
			<span className="truncate">{label}</span>
		</button>
	);
}
