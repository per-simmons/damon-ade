import { Button } from "@superset/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@superset/ui/dropdown-menu";
import { useLiveQuery } from "@tanstack/react-db";
import { useMemo, useState } from "react";
import { HiChevronDown, HiFolderOpen } from "react-icons/hi2";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";

interface ProjectFilterProps {
	value: string[];
	onChange: (value: string[]) => void;
}

export function ProjectFilter({ value, onChange }: ProjectFilterProps) {
	const collections = useCollections();
	const [open, setOpen] = useState(false);

	const { data: allTasks } = useLiveQuery(
		(q) => q.from({ tasks: collections.tasks }),
		[collections],
	);

	// Extract unique project names from task.externalProvider
	const projects = useMemo(() => {
		if (!allTasks) return [];
		const map = new Map<
			string,
			{ name: string; color: string | null; count: number }
		>();
		for (const task of allTasks) {
			const name = task.externalProvider;
			if (!name) continue;
			const existing = map.get(name);
			if (existing) {
				existing.count++;
			} else {
				map.set(name, { name, color: task.externalId, count: 1 });
			}
		}
		return Array.from(map.values()).sort((a, b) => b.count - a.count);
	}, [allTasks]);

	const toggle = (name: string) => {
		if (value.includes(name)) {
			onChange(value.filter((v) => v !== name));
		} else {
			onChange([...value, name]);
		}
	};

	const hasFilter = value.length > 0;

	return (
		<DropdownMenu open={open} onOpenChange={setOpen}>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					className={`h-8 gap-1.5 px-2 text-muted-foreground hover:text-foreground ${hasFilter ? "text-foreground bg-accent" : ""}`}
				>
					<HiFolderOpen className="size-4" />
					<span className="text-sm">Team</span>
					{hasFilter && (
						<span className="ml-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground/10 px-1 text-[10px] font-medium">
							{value.length}
						</span>
					)}
					<HiChevronDown className="size-3" />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-56">
				<div className="max-h-64 overflow-y-auto">
					{hasFilter && (
						<>
							<button
								type="button"
								onClick={() => {
									onChange([]);
									setOpen(false);
								}}
								className="w-full px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground text-left cursor-pointer"
							>
								Clear filter
							</button>
							<DropdownMenuSeparator />
						</>
					)}
					{projects.map((project) => (
						<DropdownMenuCheckboxItem
							key={project.name}
							checked={value.includes(project.name)}
							onCheckedChange={() => toggle(project.name)}
							className="text-sm"
						>
							<div className="flex items-center gap-2">
								<div
									className="w-2.5 h-2.5 rounded-full shrink-0"
									style={{ background: project.color || "#6b6b6b" }}
								/>
								<span>{project.name}</span>
								<span className="ml-auto text-xs text-muted-foreground">
									{project.count}
								</span>
							</div>
						</DropdownMenuCheckboxItem>
					))}
					<DropdownMenuSeparator />
					<DropdownMenuCheckboxItem
						checked={value.includes("__none__")}
						onCheckedChange={() => toggle("__none__")}
						className="text-sm"
					>
						<div className="flex items-center gap-2">
							<div className="w-2.5 h-2.5 rounded-full shrink-0 border border-border" />
							<span className="text-muted-foreground">No team</span>
						</div>
					</DropdownMenuCheckboxItem>
				</div>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
