/**
 * Bounded startup reconcile. Kept in its own dependency-free module (no
 * electron, no daemon singleton) so the timeout logic is unit-testable without
 * importing the electron-heavy terminal/index.ts. index.ts wires the real
 * DaemonTerminalManager into reconcileWithTimeout.
 */

/**
 * Hard bound on startup reconcile. reconcileOnStartup awaits a daemon-socket
 * connection (listSessions) and runs BEFORE the main window is created, so a
 * wedged/unresponsive daemon would otherwise block boot indefinitely. If it
 * exceeds this, we log and let boot proceed; the daemon reconciles lazily on
 * the next terminal use.
 */
export const RECONCILE_STARTUP_TIMEOUT_MS = 5000;

/** The one thing reconcileWithTimeout needs from the daemon manager. */
export interface ReconcilableManager {
	reconcileOnStartup(): Promise<void>;
}

/**
 * Resolve to `true` if `p` settles before `ms`, `false` if the timeout wins.
 * `p`'s own rejection still propagates (so the caller's catch runs). The timer
 * is unref'd so it can never keep the process alive and is cleared once `p`
 * settles.
 */
async function settledWithin(
	p: Promise<unknown>,
	ms: number,
): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), ms);
		timer.unref?.();
	});
	try {
		return await Promise.race([p.then(() => true), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Run the manager's startup reconcile under a hard timeout. Never throws:
 * a reconcile rejection is logged, and a timeout is logged and boot proceeds.
 */
export async function reconcileWithTimeout(
	manager: ReconcilableManager,
	timeoutMs: number = RECONCILE_STARTUP_TIMEOUT_MS,
): Promise<void> {
	try {
		const settled = await settledWithin(
			manager.reconcileOnStartup(),
			timeoutMs,
		);
		if (!settled) {
			console.warn(
				`[TerminalManager] reconcileOnStartup timed out after ${timeoutMs}ms; ` +
					"proceeding with boot (daemon reconciles on next terminal use).",
			);
		}
	} catch (error) {
		console.warn(
			"[TerminalManager] Failed to reconcile daemon sessions:",
			error,
		);
	}
}
