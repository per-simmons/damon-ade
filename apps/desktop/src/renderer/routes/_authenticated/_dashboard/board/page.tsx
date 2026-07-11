import { createFileRoute } from "@tanstack/react-router";
import { BoardView } from "./components/BoardView";

export const Route = createFileRoute("/_authenticated/_dashboard/board/")({
	component: BoardPage,
});

function BoardPage() {
	return <BoardView />;
}
