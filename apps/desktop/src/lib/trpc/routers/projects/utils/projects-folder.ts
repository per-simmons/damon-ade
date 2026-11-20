import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { getSupersetHomeDir } from "main/lib/app-environment";

/**
 * Where new projects (blank repositories and GitHub clones) are created by
 * default. Stored in <ADE home>/preferences.json; the New team dialog lets
 * each project use another folder.
 */

const DEFAULT_FOLDER = () => join(homedir(), "Projects");

function preferencesPath(): string {
	return join(getSupersetHomeDir(), "preferences.json");
}

function readPreferences(): { projectsFolder?: string } {
	try {
		return JSON.parse(readFileSync(preferencesPath(), "utf8"));
	} catch {
		return {};
	}
}

export function getProjectsFolder(): { path: string; isDefault: boolean } {
	const saved = readPreferences().projectsFolder;
	return saved
		? { path: saved, isDefault: false }
		: { path: DEFAULT_FOLDER(), isDefault: true };
}

export function setProjectsFolder(path: string | null): {
	path: string;
	isDefault: boolean;
} {
	const preferences = readPreferences();
	if (path === null) {
		delete preferences.projectsFolder;
	} else {
		if (!isAbsolute(path)) throw new Error("Choose a full folder path");
		preferences.projectsFolder = resolve(path);
	}
	const file = preferencesPath();
	mkdirSync(getSupersetHomeDir(), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
	renameSync(tmp, file);
	return getProjectsFolder();
}
