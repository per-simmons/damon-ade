/** "2026-11-18", or "undated". */
export function shortDate(iso: string | null | undefined): string {
	return iso ? iso.slice(0, 10) : "undated";
}
