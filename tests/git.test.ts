import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { GitState, RunState } from "../src/types.js";
import { classifyGitStatus, commitPaths, selectCommitPaths, type GitAdapter } from "../src/git.js";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function runGit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
	try {
		const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
		return { stdout: result.stdout, stderr: result.stderr, code: 0 };
	} catch (error) {
		const failure = error as Error & { stdout?: string; stderr?: string; code?: number };
		return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message, code: failure.code ?? 1 };
	}
}

async function createRepository(): Promise<{ cwd: string; adapter: GitAdapter; baseHead: string }> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "long-horizon-git-test-"));
	temporaryDirectories.push(cwd);
	await runGit(cwd, ["init", "-q"]);
	await runGit(cwd, ["config", "user.name", "Long Horizon Test"]);
	await runGit(cwd, ["config", "user.email", "long-horizon@example.test"]);
	await fs.writeFile(path.join(cwd, "selected.txt"), "selected base\n");
	await fs.writeFile(path.join(cwd, "staged.txt"), "staged base\n");
	await fs.writeFile(path.join(cwd, "unstaged.txt"), "unstaged base\n");
	await fs.writeFile(path.join(cwd, "deleted.txt"), "delete me\n");
	await fs.writeFile(path.join(cwd, "rename-source.txt"), "rename me\n");
	await runGit(cwd, ["add", "--all"]);
	await runGit(cwd, ["commit", "-q", "-m", "base"]);
	const baseHead = (await runGit(cwd, ["rev-parse", "HEAD"])).stdout.trim();
	return {
		cwd,
		adapter: {
			exec: (args) => runGit(cwd, args),
			execWithEnv: async (args, env) => {
				try {
					const result = await execFileAsync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
					return { stdout: result.stdout, stderr: result.stderr, code: 0 };
				} catch (error) {
					const failure = error as Error & { stdout?: string; stderr?: string; code?: number };
					return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? failure.message, code: failure.code ?? 1 };
				}
			},
		},
		baseHead,
	};
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const run: RunState = {
	runId: "run-1",
	mode: "single",
	startedAt: "2026-08-13T00:00:00.000Z",
	sectionId: "active",
	baseHead: "abc123",
	pendingPaths: new Map(),
	ownedPaths: new Set(["src/owned.ts", "already.ts"]),
	unownedPaths: new Set(["generated.txt"]),
	completedSections: [],
	completed: false,
};

describe("Git state", () => {
	it("parses porcelain status into staged, dirty, and conflict paths", () => {
		const state = classifyGitStatus(" M src/work.ts\nM  src/staged.ts\n?? generated.txt\nUU conflict.ts\n");

		expect(state).toMatchObject<Partial<GitState>>({
			dirtyPaths: ["conflict.ts", "generated.txt", "src/work.ts"],
			stagedPaths: ["conflict.ts", "src/staged.ts"],
			conflictPaths: ["conflict.ts"],
		});
	});

	it("parses NUL-delimited paths without quoting or directory folding", () => {
		const state = classifyGitStatus('?? new-dir/file.ts\0 M line\nbreak.txt\0??  leading\\path" \0');

		expect(state.dirtyPaths).toEqual([' leading\\path" ', "line\nbreak.txt", "new-dir/file.ts"]);
	});

	it("records both paths of NUL-delimited renames and copies", () => {
		const state = classifyGitStatus("R  src/new name.ts\0src/old name.ts\0 C copied-new.ts\0copied-old.ts\0");

		expect(state.stagedPaths).toEqual(["src/new name.ts", "src/old name.ts"]);
		expect(state.dirtyPaths).toEqual(["copied-new.ts", "copied-old.ts"]);
	});

	it("recognizes every porcelain v1 unmerged status", () => {
		const state = classifyGitStatus("DD dd\0AU au\0UD ud\0UA ua\0DU du\0AA aa\0UU uu\0");

		expect(state.conflictPaths).toEqual(["aa", "au", "dd", "du", "ua", "ud", "uu"]);
	});

	it("selects owned paths and canonical plugin files even when they were already dirty", () => {
		const cleanRun = { ...run, ownedPaths: new Set(["src/owned.ts"]) };
		const state = classifyGitStatus(" M src/owned.ts\n M already.ts\n M generated.txt\n M progress.md\n");
		const result = selectCommitPaths(cleanRun, state, ["progress.md"]);

		expect(result).toEqual({ paths: ["progress.md", "src/owned.ts"], error: undefined });
	});

	it("allows the whole file when user and agent both modify an agent-owned path", () => {
		const state = classifyGitStatus(" M already.ts\n");

		expect(selectCommitPaths(run, state, [])).toEqual({ paths: ["already.ts"], error: undefined });
	});

	it("allows a canonical plugin file that was already dirty when the run started", () => {
		const pluginRun = { ...run, ownedPaths: new Set<string>() };
		const state = classifyGitStatus(" M progress.md\n");

		expect(selectCommitPaths(pluginRun, state, ["progress.md"])).toEqual({ paths: ["progress.md"], error: undefined });
	});

	it("blocks commits when Git is unavailable or conflicts remain", () => {
		expect(selectCommitPaths(run, { available: false, head: null, dirtyPaths: [], stagedPaths: [], conflictPaths: [] }, [])).toMatchObject({
			error: /Git is unavailable/,
		});
		expect(selectCommitPaths(run, { ...classifyGitStatus("UU conflict.ts\n"), available: true, head: "abc" }, [])).toMatchObject({
			error: /conflict paths/,
		});
	});

	it("reports a failed status command as unavailable Git", async () => {
		const state = await (await import("../src/git.js")).readGitState({
			exec: async (args) =>
				args[0] === "rev-parse"
					? { stdout: "abc\n", stderr: "", code: 0 }
					: { stdout: "", stderr: "status failed", code: 1 },
		});

		expect(state.available).toBe(false);
		expect(state.error).toContain("status failed");
	});

	it("requests NUL-delimited status with all untracked files expanded", async () => {
		const calls: string[][] = [];
		await (await import("../src/git.js")).readGitState({
			exec: async (args) => {
				calls.push(args);
				return args[0] === "rev-parse"
					? { stdout: "abc\n", stderr: "", code: 0 }
					: { stdout: "", stderr: "", code: 0 };
			},
		});

		expect(calls).toContainEqual(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
	});

	it("atomically commits only selected working-tree content and preserves the user's index", async () => {
		const { cwd, adapter, baseHead } = await createRepository();
		await fs.writeFile(path.join(cwd, "selected.txt"), "selected staged version\n");
		await runGit(cwd, ["add", "--", "selected.txt"]);
		await fs.writeFile(path.join(cwd, "selected.txt"), "selected final version\n");
		await fs.writeFile(path.join(cwd, "staged.txt"), "unrelated staged\n");
		await runGit(cwd, ["add", "--", "staged.txt"]);
		await fs.writeFile(path.join(cwd, "unstaged.txt"), "unrelated unstaged\n");

		const result = await commitPaths(adapter, ["selected.txt"], "selected commit", baseHead);

		expect(result.code).toBe(0);
		expect((await runGit(cwd, ["show", "HEAD:selected.txt"])).stdout).toBe("selected final version\n");
		expect((await runGit(cwd, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])).stdout.trim()).toBe("selected.txt");
		expect((await runGit(cwd, ["diff", "--cached", "--name-only"])).stdout.trim()).toBe("staged.txt");
		expect((await runGit(cwd, ["diff", "--name-only"])).stdout.trim()).toBe("unstaged.txt");
	});

	it("treats selected file names as literal paths instead of Git pathspecs", async () => {
		const { cwd, adapter, baseHead } = await createRepository();
		await fs.writeFile(path.join(cwd, ":(glob)*"), "selected\n");
		await fs.writeFile(path.join(cwd, "unrelated-new.txt"), "must remain untracked\n");

		const result = await commitPaths(adapter, [":(glob)*"], "literal path", baseHead);

		expect(result.code).toBe(0);
		expect((await runGit(cwd, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])).stdout.trim()).toBe(":(glob)*");
		expect((await runGit(cwd, ["status", "--porcelain=v1", "--", "unrelated-new.txt"])).stdout).toBe("?? unrelated-new.txt\n");
	});

	it("stages selected deletions and both sides of a selected rename", async () => {
		const { cwd, adapter, baseHead } = await createRepository();
		await fs.rm(path.join(cwd, "deleted.txt"));
		await fs.rename(path.join(cwd, "rename-source.txt"), path.join(cwd, "rename-target.txt"));

		const result = await commitPaths(
			adapter,
			["deleted.txt", "rename-source.txt", "rename-target.txt"],
			"delete and rename",
			baseHead,
		);

		expect(result.code).toBe(0);
		expect((await runGit(cwd, ["diff-tree", "--no-commit-id", "--name-status", "-M", "-r", "HEAD"])).stdout.trim().split("\n").sort()).toEqual([
			"D\tdeleted.txt",
			"R100\trename-source.txt\trename-target.txt",
		]);
		expect((await runGit(cwd, ["status", "--porcelain=v1"])).stdout).toBe("");
	});

	it("does not create a commit when selected paths match the expected base", async () => {
		const { cwd, adapter, baseHead } = await createRepository();

		const result = await commitPaths(adapter, ["selected.txt"], "no changes", baseHead);

		expect(result).toMatchObject({ code: 0, stderr: "no changes to commit" });
		expect((await runGit(cwd, ["rev-parse", "HEAD"])).stdout.trim()).toBe(baseHead);
	});

	it("leaves HEAD and the user's index unchanged when the expected base is stale", async () => {
		const { cwd, adapter, baseHead } = await createRepository();
		await fs.writeFile(path.join(cwd, "selected.txt"), "selected change\n");
		await fs.writeFile(path.join(cwd, "staged.txt"), "staged before race\n");
		await runGit(cwd, ["add", "--", "staged.txt"]);
		await fs.writeFile(path.join(cwd, "intervening.txt"), "intervening\n");
		await runGit(cwd, ["add", "--", "intervening.txt"]);
		await runGit(cwd, ["commit", "-q", "-m", "intervening"]);
		const interveningHead = (await runGit(cwd, ["rev-parse", "HEAD"])).stdout.trim();
		await fs.writeFile(path.join(cwd, "staged.txt"), "staged after race\n");
		await runGit(cwd, ["add", "--", "staged.txt"]);

		const result = await commitPaths(adapter, ["selected.txt"], "must lose race", baseHead);

		expect(result.code).not.toBe(0);
		expect((await runGit(cwd, ["rev-parse", "HEAD"])).stdout.trim()).toBe(interveningHead);
		expect((await runGit(cwd, ["show", ":staged.txt"])).stdout).toBe("staged after race\n");
		expect((await runGit(cwd, ["diff", "--name-only"])).stdout.trim()).toBe("selected.txt");
	});

	it("loses an update-ref race after commit-tree without overwriting the new HEAD", async () => {
		const { cwd, adapter, baseHead } = await createRepository();
		await fs.writeFile(path.join(cwd, "selected.txt"), "selected change\n");
		let interveningHead = "";
		const racingAdapter: GitAdapter = {
			...adapter,
			exec: async (args) => {
				if (args[0] === "update-ref" && args[1] === "HEAD" && args[3] === baseHead && args[2] !== baseHead) {
					const tree = (await runGit(cwd, ["rev-parse", `${baseHead}^{tree}`])).stdout.trim();
					interveningHead = (await runGit(cwd, ["commit-tree", tree, "-p", baseHead, "-m", "intervening"])).stdout.trim();
					await runGit(cwd, ["update-ref", "HEAD", interveningHead, baseHead]);
				}
				return adapter.exec(args);
			},
		};

		const result = await commitPaths(racingAdapter, ["selected.txt"], "must lose race", baseHead);

		expect(result.code).not.toBe(0);
		expect(interveningHead).not.toBe("");
		expect((await runGit(cwd, ["rev-parse", "HEAD"])).stdout.trim()).toBe(interveningHead);
		expect((await runGit(cwd, ["diff", "--name-only"])).stdout.trim()).toBe("selected.txt");
	});

	it("removes its temporary index directory on success and failure", async () => {
		const { cwd, adapter, baseHead } = await createRepository();
		const prefix = "long-horizon-git-index-";
		const before = (await fs.readdir(os.tmpdir())).filter((entry) => entry.startsWith(prefix));
		await fs.writeFile(path.join(cwd, "selected.txt"), "selected change\n");
		await commitPaths(adapter, ["selected.txt"], "success", baseHead);
		await fs.writeFile(path.join(cwd, "selected.txt"), "another change\n");
		await commitPaths(adapter, ["selected.txt"], "stale", baseHead);
		const after = (await fs.readdir(os.tmpdir())).filter((entry) => entry.startsWith(prefix));

		expect(after).toEqual(before);
	});
});
