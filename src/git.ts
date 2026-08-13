import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GitState, RunState } from "./types.js";

export interface GitCommandResult {
	stdout: string;
	stderr: string;
	code: number;
}

export interface GitAdapter {
	exec(args: string[]): Promise<GitCommandResult>;
	execWithEnv?(args: string[], env: Record<string, string>): Promise<GitCommandResult>;
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
	const nulDelimited = porcelain.includes("\0");
	const records = nulDelimited ? porcelain.split("\0") : porcelain.split(/\r?\n/);
	const addPath = (filePath: string, index: string, worktree: string) => {
		if (!filePath) return;
		if (index !== " " && index !== "?") stagedPaths.push(filePath);
		if (worktree !== " ") dirtyPaths.push(filePath);
		if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(`${index}${worktree}`)) conflictPaths.push(filePath);
	};
	for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
		const line = records[recordIndex];
		if (line.length < 3) continue;
		const index = line[0];
		const worktree = line[1];
		const filePath = nulDelimited ? line.slice(3) : normalizeStatusPath(line.slice(3));
		addPath(filePath, index, worktree);
		if (nulDelimited && (index === "R" || index === "C" || worktree === "R" || worktree === "C")) {
			recordIndex += 1;
			addPath(records[recordIndex] ?? "", index, worktree);
		}
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
	const status = await adapter.exec(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
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
	const changedPaths = new Set([...git.dirtyPaths, ...git.stagedPaths]);
	const paths = [
		...new Set([
			...pluginTouchedPaths.filter((filePath) => changedPaths.has(filePath)),
			...[...run.ownedPaths].filter((filePath) => changedPaths.has(filePath)),
		]),
	];
	return { paths: paths.sort(), error: undefined };
}

export async function commitPaths(
	adapter: GitAdapter,
	paths: string[],
	message: string,
	expectedHead?: string | null,
): Promise<GitCommandResult> {
	if (!expectedHead) return { stdout: "", stderr: "expected base HEAD is required", code: 1 };
	if (!adapter.execWithEnv) return { stdout: "", stderr: "temporary Git index support is unavailable", code: 1 };

	if (paths.length === 0) {
		const unchanged = await adapter.exec(["update-ref", "HEAD", expectedHead, expectedHead]);
		return unchanged.code === 0 ? { stdout: "", stderr: "no changes to commit", code: 0 } : unchanged;
	}

	const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "long-horizon-git-index-"));
	const temporaryIndex = path.join(temporaryDirectory, "index");
	const env = { GIT_INDEX_FILE: temporaryIndex };
	try {
		const readTree = await adapter.execWithEnv(["read-tree", expectedHead], env);
		if (readTree.code !== 0) return readTree;
		const added = await adapter.execWithEnv(["--literal-pathspecs", "add", "-A", "--", ...paths], env);
		if (added.code !== 0) return added;
		const writtenTree = await adapter.execWithEnv(["write-tree"], env);
		if (writtenTree.code !== 0) return writtenTree;
		const tree = writtenTree.stdout.trim();
		const baseTreeResult = await adapter.exec(["rev-parse", `${expectedHead}^{tree}`]);
		if (baseTreeResult.code !== 0) return baseTreeResult;
		if (tree === baseTreeResult.stdout.trim()) {
			const unchanged = await adapter.exec(["update-ref", "HEAD", expectedHead, expectedHead]);
			return unchanged.code === 0 ? { stdout: "", stderr: "no changes to commit", code: 0 } : unchanged;
		}

		const committed = await adapter.execWithEnv(["commit-tree", tree, "-p", expectedHead, "-m", message], env);
		if (committed.code !== 0) return committed;
		const newCommit = committed.stdout.trim();
		const updated = await adapter.exec(["update-ref", "HEAD", newCommit, expectedHead]);
		if (updated.code !== 0) return updated;

		const synchronized = await adapter.exec(["--literal-pathspecs", "reset", "--quiet", newCommit, "--", ...paths]);
		if (synchronized.code !== 0) {
			const rolledBack = await adapter.exec(["update-ref", "HEAD", expectedHead, newCommit]);
			if (rolledBack.code !== 0) {
				return {
					stdout: newCommit,
					stderr: [synchronized.stderr, "HEAD was committed but index synchronization and rollback both failed", rolledBack.stderr]
						.filter(Boolean)
						.join("\n"),
					code: synchronized.code || 1,
				};
			}
			return synchronized;
		}
		return { stdout: `${newCommit}\n`, stderr: "", code: 0 };
	} finally {
		await fs.rm(temporaryDirectory, { recursive: true, force: true });
	}
}
