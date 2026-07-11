import { createContext, type ReactNode, useContext, useMemo } from "react";
import { MOCK_ORG_ID } from "shared/constants";
import { getCollections } from "./collections";

type CollectionsContextType = ReturnType<typeof getCollections> & {
	switchOrganization: (organizationId: string) => Promise<void>;
};

const CollectionsContext = createContext<CollectionsContextType | null>(null);

export function preloadActiveOrganizationCollections(
	_activeOrganizationId: string | null | undefined,
): void {
	// No-op in Local build (no Electric SQL sync)
}

export function CollectionsProvider({ children }: { children: ReactNode }) {
	// Local build: always use mock org, no cloud auth
	const activeOrganizationId = MOCK_ORG_ID;

	const switchOrganization = async (_organizationId: string) => {
		// No-op in Local build (single local org)
	};

	const collections = useMemo(() => {
		return getCollections(activeOrganizationId);
	}, []);

	return (
		<CollectionsContext.Provider value={{ ...collections, switchOrganization }}>
			{children}
		</CollectionsContext.Provider>
	);
}

export function useCollections(): CollectionsContextType {
	const context = useContext(CollectionsContext);
	if (!context) {
		throw new Error("useCollections must be used within CollectionsProvider");
	}
	return context;
}
