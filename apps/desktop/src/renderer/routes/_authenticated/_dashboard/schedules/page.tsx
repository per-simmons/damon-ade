import { createFileRoute } from "@tanstack/react-router";
import { SchedulesView } from "./components/SchedulesView";

export const Route = createFileRoute("/_authenticated/_dashboard/schedules/")({
	component: SchedulesPage,
});

function SchedulesPage() {
	return <SchedulesView />;
}
