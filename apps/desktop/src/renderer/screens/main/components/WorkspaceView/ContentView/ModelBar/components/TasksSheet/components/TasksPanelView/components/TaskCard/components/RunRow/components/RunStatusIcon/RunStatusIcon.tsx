import {
	LuCircleCheck,
	LuCircleDashed,
	LuCircleSlash,
	LuCircleX,
	LuLoaderCircle,
} from "react-icons/lu";

/** How a run ended (or that it is still going), as an icon. */
export function RunStatusIcon({ status }: { status: string }) {
	if (status === "running") {
		return (
			<LuLoaderCircle
				className="size-3.5 animate-spin text-sky-500"
				aria-hidden
			/>
		);
	}
	if (status === "succeeded") {
		return <LuCircleCheck className="size-3.5 text-emerald-500" aria-hidden />;
	}
	if (status === "cancelled") {
		return (
			<LuCircleSlash className="size-3.5 text-muted-foreground" aria-hidden />
		);
	}
	if (status === "queued") {
		return (
			<LuCircleDashed className="size-3.5 text-muted-foreground" aria-hidden />
		);
	}
	return <LuCircleX className="size-3.5 text-destructive" aria-hidden />;
}
