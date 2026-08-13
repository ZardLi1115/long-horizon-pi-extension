import { describe, expect, it } from "vitest";
import type { GitState, RunState } from "../src/types.js";
import { classifyGitStatus, selectCommitPaths } from "../src/git.js";

const run: RunState = {
	runId: "run-1",
	mode: "single",
	startedAt: "2026-08-13T00:00:00.000Z",
	sectionId: "active",
	baseHead: "abc123",
	preexistingDirtyPaths: ["already.ts"],
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

	it("selects only new owned paths and canonical plugin files", () => {
		const cleanRun = { ...run, ownedPaths: new Set(["src/owned.ts"]), preexistingDirtyPaths: ["already.ts"] };
		const state = classifyGitStatus(" M src/owned.ts\n M already.ts\n M generated.txt\n M progress.md\n");
		const result = selectCommitPaths(cleanRun, state, ["progress.md"]);

		expect(result).toEqual({ paths: ["progress.md", "src/owned.ts"], error: undefined });
	});

	it("rejects an owned path that was already dirty when the run started", () => {
		const state = classifyGitStatus(" M already.ts\n");

		expect(selectCommitPaths(run, state, [])).toMatchObject({
			error: /pre-existing dirty path was touched/,
		});
	});

	it("rejects a canonical plugin file that was already dirty when the run started", () => {
		const pluginRun = { ...run, preexistingDirtyPaths: ["progress.md"], ownedPaths: new Set<string>() };
		const state = classifyGitStatus(" M progress.md\n");

		expect(selectCommitPaths(pluginRun, state, ["progress.md"])).toMatchObject({
			error: /pre-existing dirty path was touched/,
		});
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
});
