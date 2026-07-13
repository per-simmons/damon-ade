import { createFileRoute } from "@tanstack/react-router";
import { ChatView } from "./components/ChatView";

export const Route = createFileRoute("/_authenticated/_dashboard/chat/")({
	component: ChatPage,
});

function ChatPage() {
	return <ChatView />;
}
