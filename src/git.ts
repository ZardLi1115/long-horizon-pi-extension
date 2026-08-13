import type { GitState, RunState } from "./types.js";

export interface GitCommandResult {
	stdout: string;
	stderr: string;
	code: number;
}

export interface GitAdapter {
	exec(args: string[]): Promise<GitCommandResult>;
}

export interface CommitPathSelection {
	paths: string[];
	error?: string;
}

function normalizeStatusPath(value: string): string {
	const unquoted = value.trim().replace(/^"|"$/g, "");
	const renameSeparator = unquoted.lastIndexOf(" -> ");
	return (renameSeparator >= 0 ? unquoted.slice(renameSeparator + 4) : unquoted).replace(/\\/g, "/");
}

export function classifyGitStatus(porcelain: string): GitState {
	const dirtyPaths: string[] = [];
	const stagedPaths: string[] = [];
	const conflictPaths: string[] = [];
	for (const line of porcelain.split(/\r?\n/)) {
		if (line.length < 3) continue;
		const index = line[0];
		const worktree = line[1];
		const filePath = normalizeStatusPath(line.slice(3));
		if (!filePath) continue;
		if (index !== " " && index !== "?") stagedPaths.push(filePath);
		if (worktree !== " ") dirtyPaths.push(filePath);
		if (index === "U" || worktree === "U" || (index === "A" && worktree === "A")) conflictPaths.push(filePath);
	}
	return {
		available: true,
		head: null,
		dirtyPaths: [...new Set(dirtyPaths)].sort(),
		stagedPaths: [...new Set(stagedPaths)].sort(),
		conflictPaths: [...new Set(conflictPaths)].sort(),
	};
}

export async function readGitState(adapter: GitAdapter): Promise<GitState> {
	const head = await adapter.exec(["rev-parse", "HEAD"]);
	if (head.code !== 0) {
		return {
			available: false,
			head: null,
			dirtyPaths: [],
			stagedPaths: [],
			conflictPaths: [],
			error: head.stderr.trim() || "not a Git repository",
		};
	}
	const status = await adapter.exec(["status", "--porcelain=v1"]);
	if (status.code !== 0) {
		return {
			available: false,
			head: head.stdout.trim() || null,
			dirtyPaths: [],
			stagedPaths: [],
			conflictPaths: [],
			error: status.stderr.trim() || `git status exited with code ${status.code}`,
		};
	}
	const parsed = classifyGitStatus(status.stdout);
	return { ...parsed, head: head.stdout.trim() || null };
}

export function selectCommitPaths(run: RunState, git: GitState, pluginTouchedPaths: string[]): CommitPathSelection {
	if (!git.available) return { paths: [], error: "Git is unavailable" };
	if (git.conflictPaths.length > 0) return { paths: [], error: `conflict paths remain: ${git.conflictPaths.join(", ")}` };
	const preexisting = new Set(run.preexistingDirtyPaths);
	const touchedCanonicalPath = pluginTouchedPaths.find((filePath) => preexisting.has(filePath));
	if (touchedCanonicalPath) return { paths: [], error: `pre-existing dirty path was touched: ${touchedCanonicalPath}` };
	const owned = [...run.ownedPaths].filter((filePath) => !preexisting.has(filePath));
	const touched = [...pluginTouchedPaths].filter((filePath) => !preexisting.has(filePath));
	const changedPaths = new Set([...git.dirtyPaths, ...git.stagedPaths]);
	const paths = [
		...new Set([
			...touched.filter((filePath) => changedPaths.has(filePath)),
			...owned.filter((filePath) => changedPaths.has(filePath)),
		]),
	];
	const boundaryPath = [...run.ownedPaths].find((filePath) => preexisting.has(filePath));
	if (boundaryPath) return { paths: [], error: `pre-existing dirty path was touched: ${boundaryPath}` };
	return { paths: paths.sort(), error: undefined };
}

export async function commitPaths(adapter: GitAdapter, paths: string[], message: string): Promise<GitCommandResult> {
	if (paths.length === 0) return { stdout: "", stderr: "no changes to commit", code: 0 };
	const added = await adapter.exec(["add", "--", ...paths]);
	if (added.code !== 0) return added;
	return adapter.exec(["commit", "-m", message, "--", ...paths]);
}
