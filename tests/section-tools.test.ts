import { describe, expect, it } from "vitest";
import { parsePlan } from "../src/plan.js";
import { completeSection, reopenSection } from "../src/section-tools.js";
import type { GitState, ProgressState, RunState } from "../src/types.js";

const plan = parsePlan(
	[
		"### One",
		"<!-- id: one -->",
		"### Two",
		"<!-- id: two -->",
		"### Three",
		"<!-- id: three -->",
	].join("\n"),
);

const git: GitState = { available: true, head: "abc", dirtyPaths: ["progress.md", "src/file.ts"], stagedPaths: [], conflictPaths: [] };

function makeRun(mode: "single" | "multi"): RunState {
	return {
		runId: "run-1",
		mode,
		startedAt: "2026-08-13T00:00:00.000Z",
		sectionId: "one",
		baseHead: "abc",
		preexistingDirtyPaths: [],
		pendingPaths: new Map(),
		ownedPaths: new Set(["src/file.ts"]),
		unownedPaths: new Set(),
		completedSections: [],
		completed: false,
	};
}

function makeProgress(): ProgressState {
	return { active: "one", attempts: 1, done: [], blocker: [], tried: [], next: [], unknown: [] };
}

describe("section operations", () => {
	it("verifies, persists, commits, and aborts once in single mode", async () => {
		const persisted: ProgressState[] = [];
		const commits: Array<{ paths: string[]; message: string }> = [];
		let aborts = 0;

		const result = await completeSection({
			id: "one",
			verify: "npm test -- auth",
			note: "auth section complete",
			run: makeRun("single"),
			plan,
			progress: makeProgress(),
			git,
			runVerify: async () => ({ code: 0, stdout: "ok", stderr: "" }),
			persistProgress: async (state) => {
				persisted.push(state);
			},
			selectCommitPaths: () => ({ paths: ["progress.md", "src/file.ts"] }),
			commit: async (paths, message) => {
				commits.push({ paths, message });
			},
			abort: () => {
				aborts += 1;
			},
		});

		expect(result.ok).toBe(true);
		expect(result.status).toBe("verified");
		expect(result.progress.active).toBe("two");
		expect(result.progress.done).toEqual(["one"]);
		expect(result.run.completed).toBe(true);
		expect(persisted).toHaveLength(1);
		expect(commits).toEqual([{ paths: ["progress.md", "src/file.ts"], message: "long-horizon: complete one" }]);
		expect(aborts).toBe(1);
	});

	it("keeps the section active and does not commit after failed verification", async () => {
		const persisted: ProgressState[] = [];
		let commits = 0;

		const result = await completeSection({
			id: "one",
			verify: "npm test -- auth",
			run: makeRun("multi"),
			plan,
			progress: makeProgress(),
			git,
			runVerify: async () => ({ code: 1, stdout: "lots of output", stderr: "failure details" }),
			persistProgress: async (state) => {
				persisted.push(state);
			},
			selectCommitPaths: () => ({ paths: ["progress.md"] }),
			commit: async () => {
				commits += 1;
			},
			abort: () => {
				throw new Error("multi must not abort");
			},
		});

		expect(result.ok).toBe(false);
		expect(result.status).toBe("verify_failed");
		expect(result.progress.active).toBe("one");
		expect(result.progress.attempts).toBe(2);
		expect(result.progress.blocker[0]).toContain("failure details");
		expect(persisted).toHaveLength(1);
		expect(commits).toBe(0);
	});

	it("allows an explicit unverified completion and continues in multi mode", async () => {
		let aborts = 0;
		const result = await completeSection({
			id: "one",
			run: makeRun("multi"),
			plan,
			progress: makeProgress(),
			git,
			persistProgress: async () => undefined,
			selectCommitPaths: () => ({ paths: [] }),
			commit: async () => undefined,
			abort: () => {
				aborts += 1;
			},
		});

		expect(result.ok).toBe(true);
		expect(result.status).toBe("unverified");
		expect(result.run.sectionId).toBe("two");
		expect(aborts).toBe(0);
	});

	it("rejects a section other than the run lock", async () => {
		const result = await completeSection({
			id: "two",
			run: makeRun("single"),
			plan,
			progress: makeProgress(),
			git,
			persistProgress: async () => undefined,
			selectCommitPaths: () => ({ paths: [] }),
			commit: async () => undefined,
			abort: () => undefined,
		});

		expect(result.ok).toBe(false);
		expect(result.status).toBe("rejected");
		expect(result.message).toContain("locked section");
	});

	it("rejects completion when progress moved away from the run lock", async () => {
		let persisted = 0;
		const result = await completeSection({
			id: "one",
			run: makeRun("single"),
			plan,
			progress: { ...makeProgress(), active: "two" },
			git,
			persistProgress: async () => {
				persisted += 1;
			},
			selectCommitPaths: () => ({ paths: [] }),
			commit: async () => undefined,
			abort: () => undefined,
		});

		expect(result.ok).toBe(false);
		expect(result.status).toBe("rejected");
		expect(result.message).toContain("active section changed");
		expect(persisted).toBe(0);
	});

	it("rejects completion after the Git HEAD changes", async () => {
		let persisted = 0;
		let commits = 0;
		const result = await completeSection({
			id: "one",
			run: makeRun("single"),
			plan,
			progress: makeProgress(),
			git,
			persistProgress: async () => {
				persisted += 1;
			},
			refreshGit: async () => ({ ...git, head: "def" }),
			selectCommitPaths: () => ({ paths: ["progress.md"] }),
			commit: async () => {
				commits += 1;
			},
			abort: () => undefined,
		});

		expect(result.ok).toBe(false);
		expect(result.status).toBe("commit_failed");
		expect(result.message).toContain("HEAD changed");
		expect(commits).toBe(0);
		expect(persisted).toBe(0);
	});

	it("reopens a completed section without touching Git history", async () => {
		const result = await reopenSection({
			id: "one",
			reason: "regression found",
			plan,
			progress: { ...makeProgress(), active: "two", done: ["one"] },
			persistProgress: async () => undefined,
		});

		expect(result.ok).toBe(true);
		expect(result.progress.active).toBe("one");
		expect(result.progress.done).toEqual([]);
		expect(result.progress.blocker).toEqual(["regression found"]);
	});

	it("rejects reopening a section that is not completed", async () => {
		const result = await reopenSection({
			id: "one",
			plan,
			progress: makeProgress(),
			persistProgress: async () => undefined,
		});

		expect(result.ok).toBe(false);
		expect(result.message).toContain("not completed");
	});

	it("rolls progress back when the commit boundary is rejected", async () => {
		const persisted: ProgressState[] = [];
		const result = await completeSection({
			id: "one",
			run: makeRun("single"),
			plan,
			progress: makeProgress(),
			git,
			persistProgress: async (state) => {
				persisted.push(state);
			},
			selectCommitPaths: () => ({ paths: [], error: "pre-existing dirty path was touched: progress.md" }),
			commit: async () => undefined,
			abort: () => undefined,
		});

		expect(result.ok).toBe(false);
		expect(result.status).toBe("commit_failed");
		expect(result.progress.active).toBe("one");
		expect(persisted).toHaveLength(2);
		expect(persisted.at(-1)?.active).toBe("one");
	});

	it("reports when completion has no paths to commit", async () => {
		const result = await completeSection({
			id: "one",
			run: makeRun("single"),
			plan,
			progress: makeProgress(),
			git,
			persistProgress: async () => undefined,
			selectCommitPaths: () => ({ paths: [] }),
			commit: async () => undefined,
			abort: () => undefined,
		});

		expect(result.ok).toBe(true);
		expect(result.message).toContain("no changes to commit");
	});

	it("refreshes Git after progress persistence before selecting commit paths", async () => {
		let refreshed = false;
		const result = await completeSection({
			id: "one",
			run: makeRun("multi"),
			plan,
			progress: makeProgress(),
			git: { ...git, dirtyPaths: [] },
			persistProgress: async () => undefined,
			refreshGit: async () => {
				refreshed = true;
				return git;
			},
			selectCommitPaths: (currentGit) => ({ paths: currentGit.dirtyPaths }),
			commit: async () => undefined,
			abort: () => undefined,
		});

		expect(refreshed).toBe(true);
		expect(result.commitPaths).toEqual(["progress.md", "src/file.ts"]);
	});

	it("updates the multi-run HEAD baseline after a section commit", async () => {
		let committed = false;
		const result = await completeSection({
			id: "one",
			run: makeRun("multi"),
			plan,
			progress: makeProgress(),
			git,
			persistProgress: async () => undefined,
			refreshGit: async () => ({ ...git, head: committed ? "def" : "abc" }),
			selectCommitPaths: () => ({ paths: ["progress.md", "src/file.ts"] }),
			commit: async () => {
				committed = true;
			},
			abort: () => undefined,
		});

		expect(result.ok).toBe(true);
		expect(result.run.sectionId).toBe("two");
		expect(result.run.baseHead).toBe("def");
	});

	it("does not absorb newly unowned changes into the next multi-section baseline", async () => {
		let committed = false;
		const result = await completeSection({
			id: "one",
			run: { ...makeRun("multi"), unownedPaths: new Set(["unowned.ts"]) },
			plan,
			progress: makeProgress(),
			git,
			persistProgress: async () => undefined,
			refreshGit: async () => ({
				...git,
				head: committed ? "def" : "abc",
				dirtyPaths: committed ? ["unowned.ts"] : git.dirtyPaths,
			}),
			selectCommitPaths: () => ({ paths: ["progress.md", "src/file.ts"] }),
			commit: async () => {
				committed = true;
			},
			abort: () => undefined,
		});

		expect(result.ok).toBe(true);
		expect(result.run.preexistingDirtyPaths).not.toContain("unowned.ts");
	});
});
