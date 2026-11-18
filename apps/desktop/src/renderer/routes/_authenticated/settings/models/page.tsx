import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
import { useSettingsSearchQuery } from "renderer/stores/settings-state";
import { getMatchingItemsForSection } from "../utils/settings-search";
import { ModelsSettings } from "./components/ModelsSettings";

export const Route = createFileRoute("/_authenticated/settings/models/")({
	component: ModelsSettingsPage,
});

function ModelsSettingsPage() {
	const searchQuery = useSettingsSearchQuery();

	const visibleItems = useMemo(() => {
		if (!searchQuery) return null;
		return getMatchingItemsForSection(searchQuery, "models").map(
			(item) => item.id,
		);
	}, [searchQuery]);

	return <ModelsSettings visibleItems={visibleItems} />;
}
