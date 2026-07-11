import { Spinner } from "@superset/ui/spinner";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";

export const Route = createFileRoute("/_authenticated/_dashboard/workspace/")({
	component: WorkspaceIndexPage,
});

function LoadingSpinner() {
	return (
		<div className="flex h-full w-full items-center justify-center">
			<Spinner className="size-5" />
		</div>
	);
}

function WorkspaceIndexPage() {
	const navigate = useNavigate();
	const { data: workspaces, isLoading } =
		electronTrpc.workspaces.getAllGrouped.useQuery();

	const groups = workspaces ?? [];
	const allWorkspaces = groups.flatMap((group) => group.workspaces);
	const hasNoWorkspaces = !isLoading && allWorkspaces.length === 0;

	useEffect(() => {
		if (isLoading || !workspaces) return;

		if (groups.length === 0) {
			// No categories yet: clean onboarding screen (no sidebar/topbar).
			navigate({ to: "/welcome", replace: true });
			return;
		}

		if (allWorkspaces.length === 0) {
			// Categories exist but no agents: show the rail + list so the user
			// can add an agent to a category.
			navigate({ to: "/workspaces", replace: true });
			return;
		}

		// Try to restore last viewed workspace
		const lastViewedId = localStorage.getItem("lastViewedWorkspaceId");
		const targetWorkspace =
			allWorkspaces.find((w) => w.id === lastViewedId) ?? allWorkspaces[0];

		if (targetWorkspace) {
			navigate({
				to: "/workspace/$workspaceId",
				params: { workspaceId: targetWorkspace.id },
				replace: true,
			});
		}
	}, [workspaces, isLoading, navigate, allWorkspaces, groups.length]);

	if (hasNoWorkspaces) {
		return <LoadingSpinner />;
	}

	return <LoadingSpinner />;
}
