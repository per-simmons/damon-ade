/**
 * Electron Builder Configuration
 * @see https://www.electron.build/configuration/configuration
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Configuration } from "electron-builder";
import pkg from "./package.json";

const currentYear = new Date().getFullYear();
const author = pkg.author?.name ?? pkg.author;
const productName = pkg.productName;

// Release repo — single source of truth for where artifacts + update manifests
// are published. TODO(release): confirm GitHub owner/org and set the public repo
// name before publishing. Must stay in sync with RELEASE_REPO_* in
// src/main/lib/auto-updater.ts.
const RELEASE_REPO_OWNER = "per-simmons"; // TODO(release): confirm GitHub owner/org
const RELEASE_REPO_NAME = "damon-ade"; // TODO(release): set public repo name

// Notarize only when Apple credentials are present in the environment
// (CI signing job, or a local signed build). electron-builder reads the
// APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID env vars to run
// notarytool. Unsigned local smoke-test builds leave APPLE_TEAM_ID unset and
// skip notarization automatically.
const notarize = Boolean(process.env.APPLE_TEAM_ID);
const hasWindowsSigningConfig = Boolean(
	process.env.WIN_CSC_LINK ||
		process.env.CSC_LINK ||
		process.env.WIN_CSC_NAME ||
		process.env.CSC_NAME ||
		process.env.AZURE_TENANT_ID,
);
const shouldSignAndEditWindowsExecutable =
	hasWindowsSigningConfig || process.env.ADE_WIN_EDIT_EXECUTABLE === "true";
const macIconPath = join(pkg.resources, "build/icons/icon.icns");
const linuxIconPath = join(pkg.resources, "build/icons");
const winIconPath = join(pkg.resources, "build/icons/icon.ico");

const config: Configuration = {
	appId: "studio.persimmons.ade",
	productName,
	copyright: `Copyright © ${currentYear} — ${author}`,
	electronVersion: pkg.devDependencies.electron.replace(/^\^/, ""),

	// Generate update manifests for all channels (latest.yml, canary.yml, etc.)
	// This enables proper channel-based auto-updates following electron-builder conventions
	generateUpdatesFilesForAllChannels: true,

	// Publish target for update manifests (latest-mac.yml, etc.). The release
	// workflow uploads artifacts itself (--publish never), but this makes the
	// generated manifests reference the correct public repo.
	publish: {
		provider: "github",
		owner: RELEASE_REPO_OWNER,
		repo: RELEASE_REPO_NAME,
	},

	// Directories
	directories: {
		output: "release",
		buildResources: join(pkg.resources, "build"),
	},

	// ASAR configuration for native modules and external resources
	asar: true,
	asarUnpack: [
		"**/node_modules/better-sqlite3/**/*",
		// better-sqlite3 uses `bindings` to locate native modules - must be unpacked together
		"**/node_modules/bindings/**/*",
		"**/node_modules/file-uri-to-path/**/*",
		"**/node_modules/node-pty/**/*",
		// ast-grep native bindings (package + platform binary package)
		"**/node_modules/@ast-grep/napi*/**/*",
		// libsql native bindings are loaded from @libsql/<platform>
		"**/node_modules/@libsql/**/*",
		// Sound files must be unpacked so external audio players (afplay, paplay, etc.) can access them
		"**/resources/sounds/**/*",
		// Tray icon must be unpacked so Electron Tray can load it
		"**/resources/tray/**/*",
	],

	// Extra resources placed outside asar archive (accessible via process.resourcesPath)
	extraResources: [
		// Database migrations - must be outside asar for drizzle-orm to read
		{
			from: "dist/resources/migrations",
			to: "resources/migrations",
			filter: ["**/*"],
		},
	],

	files: [
		"dist/**/*",
		"package.json",
		{
			from: pkg.resources,
			to: "resources",
			filter: ["**/*"],
		},
		// Native modules that can't be bundled by Vite.
		// bun creates symlinks for direct deps in workspace node_modules.
		// The copy:native-modules script replaces symlinks with real files
		// before building (required for Bun 1.3+ isolated installs).
		{
			from: "node_modules/better-sqlite3",
			to: "node_modules/better-sqlite3",
			filter: ["**/*"],
		},
		// better-sqlite3 uses `bindings` package to locate its native .node file
		{
			from: "node_modules/bindings",
			to: "node_modules/bindings",
			filter: ["**/*"],
		},
		// `bindings` requires `file-uri-to-path` for file:// URL handling
		{
			from: "node_modules/file-uri-to-path",
			to: "node_modules/file-uri-to-path",
			filter: ["**/*"],
		},
		{
			from: "node_modules/node-pty",
			to: "node_modules/node-pty",
			filter: ["**/*"],
		},
		// ast-grep native bindings (package + platform binary package)
		{
			from: "node_modules/@ast-grep",
			to: "node_modules/@ast-grep",
			filter: ["**/*"],
		},
		{
			from: "node_modules/libsql",
			to: "node_modules/libsql",
			filter: ["**/*"],
		},
		{
			from: "node_modules/@libsql",
			to: "node_modules/@libsql",
			filter: ["**/*"],
		},
		{
			from: "node_modules/@neon-rs",
			to: "node_modules/@neon-rs",
			filter: ["**/*"],
		},
		{
			from: "node_modules/detect-libc",
			to: "node_modules/detect-libc",
			filter: ["**/*"],
		},
		// friendly-words is a CommonJS module that Vite doesn't bundle
		{
			from: "node_modules/friendly-words",
			to: "node_modules/friendly-words",
			filter: ["**/*"],
		},
		"!**/.DS_Store",
	],

	// Native modules are prepared by scripts/copy-native-modules.ts and
	// validated before packaging. Rebuilding here forces node-gyp for node-pty
	// on Windows even though node-pty ships prebuilds for win32-x64/win32-arm64.
	npmRebuild: false,

	// macOS
	mac: {
		...(existsSync(macIconPath) ? { icon: macIconPath } : {}),
		category: "public.app-category.utilities",
		target: [
			{
				target: "default",
				arch: ["arm64"],
			},
		],
		// Hardened runtime is required for Apple notarization. The entitlements
		// below (allow-jit, allow-unsigned-executable-memory,
		// disable-library-validation) keep Electron + native modules working
		// under the hardened runtime.
		hardenedRuntime: true,
		gatekeeperAssess: false,
		notarize,
		entitlements: join(pkg.resources, "build/entitlements.mac.plist"),
		entitlementsInherit: join(
			pkg.resources,
			"build/entitlements.mac.inherit.plist",
		),
		extendInfo: {
			CFBundleName: productName,
			CFBundleDisplayName: productName,
			// Required for macOS microphone permission prompt
			NSMicrophoneUsageDescription:
				"ADE needs microphone access so voice-enabled tools like Codex transcription can capture audio input.",
			// Required for macOS local network permission prompt
			NSLocalNetworkUsageDescription:
				"ADE needs access to your local network to discover and connect to development servers running on your network.",
			// Bonjour service types to browse for (triggers the permission prompt)
			NSBonjourServices: ["_http._tcp", "_https._tcp"],
			// Required for Apple Events / Automation permission prompt
			NSAppleEventsUsageDescription:
				"ADE needs to interact with other applications to run terminal commands and development tools.",
		},
	},

	// Deep linking protocol
	protocols: {
		name: productName,
		schemes: ["ade"],
	},

	// Linux
	linux: {
		...(existsSync(linuxIconPath) ? { icon: linuxIconPath } : {}),
		category: "Utility",
		synopsis: pkg.description,
		target: ["AppImage"],
		artifactName: `ade-\${version}-\${arch}.\${ext}`,
	},

	// Windows
	win: {
		...(existsSync(winIconPath) ? { icon: winIconPath } : {}),
		signAndEditExecutable: shouldSignAndEditWindowsExecutable,
		target: [
			{
				target: "nsis",
				arch: ["x64"],
			},
		],
		artifactName: `${productName}-${pkg.version}-\${arch}.\${ext}`,
	},

	// NSIS installer (Windows)
	nsis: {
		oneClick: false,
		allowToChangeInstallationDirectory: true,
	},
};

export default config;
