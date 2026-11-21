import type { BrowserWindow } from "electron";
import express from "express";

/**
 * Dev-only HTTP bridge. Lets external scripts (curl) drive the renderer by
 * executing arbitrary JS via webContents.executeJavaScript. Gated on
 * NODE_ENV=development at the call site. Listens on a fixed port distinct from
 * the Chromium debug port (which collides between dev/prod ADE instances).
 */

// ADE_TEST_SERVER_PORT lets a second dev instance run alongside another.
export const TEST_SERVER_PORT =
	Number(process.env.ADE_TEST_SERVER_PORT) || 41732;

let getMainWindow: (() => BrowserWindow | null) | null = null;

export function configureTestServer(getter: () => BrowserWindow | null) {
	getMainWindow = getter;
}

const app = express();
app.use(express.json({ limit: "4mb" }));

app.get("/test/health", (_req, res) => {
	const win = getMainWindow?.();
	res.json({ ok: true, hasWindow: !!win, port: TEST_SERVER_PORT });
});

app.post("/test/eval", async (req, res) => {
	const win = getMainWindow?.();
	if (!win) {
		res.status(503).json({ error: "no_window" });
		return;
	}
	const { expression } = (req.body ?? {}) as { expression?: unknown };
	if (typeof expression !== "string") {
		res.status(400).json({ error: "expression must be a string" });
		return;
	}
	try {
		const result = await win.webContents.executeJavaScript(expression, true);
		res.json({ result });
	} catch (e) {
		res.status(500).json({
			error: e instanceof Error ? e.message : String(e),
			stack: e instanceof Error ? e.stack : undefined,
		});
	}
});

export const testServerApp = app;
