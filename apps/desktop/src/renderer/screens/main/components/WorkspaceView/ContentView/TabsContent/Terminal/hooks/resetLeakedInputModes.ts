/**
 * Restored scrollback can contain a dead TUI's DECSET sequences (mouse
 * tracking, focus reporting). Replaying them re-arms those modes in the
 * frontend emulator even though the TUI is gone, so mouse movement gets
 * typed into the shell as junk like "35;9;2M". Write this after any
 * scrollback replay to switch the input-reporting modes back off — it only
 * touches emulator state, never the PTY.
 */
export const RESET_LEAKED_INPUT_MODES =
	"\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1006l\x1b[?1004l";
