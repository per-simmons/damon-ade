import { cn } from "@superset/ui/utils";
import type { IconType } from "react-icons";
import {
	LuCircleAlert,
	LuCircleCheck,
	LuCircleDashed,
	LuCirclePause,
	LuCircleSlash,
	LuCircleX,
	LuLoaderCircle,
	LuMessageCircleQuestion,
} from "react-icons/lu";

interface StateStyle {
	label: string;
	icon: IconType;
	tone: string;
	spin?: boolean;
}

/** One look per task state, shared by Tasks and Team plans. */
export const STATE_STYLES: Record<string, StateStyle> = {
	idle: {
		label: "Ready",
		icon: LuCircleDashed,
		tone: "border-border bg-muted/40 text-muted-foreground",
	},
	running: {
		label: "Running",
		icon: LuLoaderCircle,
		tone: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
		spin: true,
	},
	paused: {
		label: "Paused",
		icon: LuCirclePause,
		tone: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
	},
	"needs-input": {
		label: "Needs your answer",
		icon: LuMessageCircleQuestion,
		tone: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
	},
	blocked: {
		label: "Blocked",
		icon: LuCircleAlert,
		tone: "border-destructive/30 bg-destructive/10 text-destructive",
	},
	failed: {
		label: "Failed",
		icon: LuCircleX,
		tone: "border-destructive/30 bg-destructive/10 text-destructive",
	},
	done: {
		label: "Done (verified)",
		icon: LuCircleCheck,
		tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
	},
	cancelled: {
		label: "Cancelled",
		icon: LuCircleSlash,
		tone: "border-border bg-muted/40 text-muted-foreground",
	},
};

interface StatusBadgeProps {
	state: string;
	/** A shorter label for tight spaces. */
	label?: string;
	className?: string;
}

/** A task's state: colour and icon by state, the words always shown. */
export function StatusBadge({ state, label, className }: StatusBadgeProps) {
	const style = STATE_STYLES[state] ?? {
		label: state,
		icon: LuCircleDashed,
		tone: "border-border bg-muted/40 text-muted-foreground",
	};
	const Icon = style.icon;
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
				style.tone,
				className,
			)}
			data-status={state}
		>
			<Icon
				className={cn("size-3", style.spin && "animate-spin")}
				aria-hidden
			/>
			{label ?? style.label}
		</span>
	);
}
