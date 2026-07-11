import { $ } from "bun";

// Prevent infinite recursion during postinstall
// electron-builder install-app-deps can trigger nested bun installs
// which would re-run postinstall, spawning hundreds of processes
if (process.env.SUPERSET_POSTINSTALL_RUNNING) {
  process.exit(0);
}

process.env.SUPERSET_POSTINSTALL_RUNNING = "1";

// Run sherif for workspace validation
await $`sherif`;

// Install native dependencies for desktop app
await $`bun run --filter=@ade/desktop install:deps`;
