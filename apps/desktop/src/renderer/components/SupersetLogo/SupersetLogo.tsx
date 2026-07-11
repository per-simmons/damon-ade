import { cn } from "@superset/ui/utils";

interface SupersetLogoProps {
	className?: string;
}

export function SupersetLogo({ className }: SupersetLogoProps) {
	return (
		<span
			role="img"
			className={cn(
				"text-foreground font-mono font-bold tracking-[0.25em] text-4xl uppercase select-none",
				className,
			)}
			aria-label="ADE"
		>
			ADE
		</span>
	);
}
