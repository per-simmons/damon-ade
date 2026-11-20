import type { ReactNode } from "react";

interface DetailProps {
	label: string;
	children: ReactNode;
	[data: `data-${string}`]: boolean | undefined;
}

/** One labelled line of a task card's details (inside a two-column <dl>). */
export function Detail({ label, children, ...rest }: DetailProps) {
	return (
		<div className="contents">
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="min-w-0 break-words" {...rest}>
				{children}
			</dd>
		</div>
	);
}
