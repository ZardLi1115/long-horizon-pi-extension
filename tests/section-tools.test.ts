import { describe, expect, it } from "vitest";
import { parsePlan } from "../src/plan.js";
import { completeSection, recordAttemptFailure, reopenSection } from "../src/section-tools.js";
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
		pendingPaths: new Map(),
		ownedPaths: new Set(["src/file.ts"]),
		unownedPaths: new Set(),
		completedSections: [],
		completed: false,
	};
}

function makeProgress(): ProgressState {
	return { active: "one", attempts: 0, done: [], blocker: [], tried: [], next: [], unknown: [] };
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

	it("keeps the section active without recording an attempt after failed verification", async () => {
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
		expect(result.progress.attempts).toBe(0);
		expect(result.progress.blocker).toEqual([]);
		expect(persisted).toHaveLength(0);
		expect(commits).toBe(0);
	});

	it("records consecutive model-declared failed attempts and persists execution memory", async () => {
		const persisted: ProgressState[] = [];
		const first = await recordAttemptFailure({
			id: "one",
			tried: "replaced the token parser",
			blocker: "the focused test still rejects rotated tokens",
			next: "inspect the fixture setup",
			progress: makeProgress(),
			persistProgress: async (state) => {
				persisted.push(state);
			},
		});
		const second = await recordAttemptFailure({
			id: "one",
			tried: "changed the fixture setup",
			blocker: "the same assertion still fails",
			next: "trace the token lookup",
			progress: first.progress,
			persistProgress: async (state) => {
				persisted.push(state);
			},
		});

		expect(first).toMatchObject({ ok: true, message: "recorded failed attempt for one" });
		expect(second.progress).toMatchObject({
			attempts: 2,
			tried: ["replaced the token parser", "changed the fixture setup"],
			blocker: ["the same assertion still fails"],
			next: ["trace the token lookup"],
		});
		expect(persisted).toEqual([first.progress, second.progress]);
	});

	it("rejects a failure record for a section other than the active section", async () => {
		let persisted = 0;
		const result = await recordAttemptFailure({
			id: "two",
			tried: "wrong section",
			blocker: "wrong section",
			next: "wrong section",
			progress: makeProgress(),
			persistProgress: async () => {
				persisted += 1;
			},
		});

		expect(result.ok).toBe(false);
		expect(result.message).toContain("active section");
		expect(persisted).toBe(0);
	});

	it("allows an explicit unverified completion and continues in multi mode", async () => {
		let aborts = 0;
		const result = await completeSection({
			id: "one",
			skipVerify: true,
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

	it("uses the plan section verify command when the tool does not override it", async () => {
		const verifiedPlan = parsePlan(
			[
				"### One",
				"<!-- id: one -->",
				"<!-- verify: npm test -- auth -->",
				"### Two",
				"<!-- id: two -->",
			].join("\n"),
		);
		let command = "";
		const result = await completeSection({
			id: "one",
			run: makeRun("single"),
			plan: verifiedPlan,
			progress: makeProgress(),
			git,
			runVerify: async (value) => {
				command = value;
				return { code: 0, stdout: "ok", stderr: "" };
			},
			persistProgress: async () => undefined,
			selectCommitPaths: () => ({ paths: [] }),
			commit: async () => undefined,
			abort: () => undefined,
		});

		expect(result.ok).toBe(true);
		expect(result.status).toBe("verified");
		expect(command).toBe("npm test -- auth");
	});

	it("validates owned file contents after verification", async () => {
		const order: string[] = [];
		let persisted = 0;
		let commits = 0;
		const result = await completeSection({
			id: "one",
			verify: "npm test -- auth",
			run: makeRun("single"),
			plan,
			progress: makeProgress(),
			git,
			runVerify: async () => {
				order.push("verify");
				return { code: 0, stdout: "ok", stderr: "" };
			},
			validateOwnedPaths: async () => {
				order.push("validate");
				return ["src/file.ts"];
			},
			persistProgress: async () => {
				persisted += 1;
			},
			selectCommitPaths: () => ({ paths: ["progress.md"] }),
			commit: async () => {
				commits += 1;
			},
			abort: () => undefined,
		});

		expect(order).toEqual(["verify", "validate"]);
		expect(result.ok).toBe(false);
		expect(result.status).toBe("commit_failed");
		expect(result.message).toContain("owned paths changed outside");
		expect(persisted).toBe(0);
		expect(commits).toBe(0);
	});

	it("rejects an unverified completion unless skipVerify is explicit", async () => {
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

		expect(result.ok).toBe(false);
		expect(result.status).toBe("rejected");
		expect(result.message).toContain("skipVerify");
	});

	it("rejects verify and skipVerify together", async () => {
		const result = await completeSection({
			id: "one",
			verify: "npm test",
			skipVerify: true,
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
		expect(result.message).toContain("cannot be used together");
	});

	it("rejects verify and skipVerify false together", async () => {
		const result = await completeSection({
			id: "one",
			verify: "npm test",
			skipVerify: false,
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
		expect(result.message).toContain("cannot be used together");
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
			skipVerify: true,
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
			skipVerify: true,
			run: makeRun("single"),
			plan,
			progress: makeProgress(),
			git,
			persistProgress: async (state) => {
				persisted.push(state);
			},
			selectCommitPaths: () => ({ paths: [], error: "conflict paths remain: progress.md" }),
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
			skipVerify: true,
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
			skipVerify: true,
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
			skipVerify: true,
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

	it("does not carry dirty paths into the next multi section's ownership", async () => {
		let committed = false;
		const result = await completeSection({
			id: "one",
			skipVerify: true,
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
		expect(result.run.unownedPaths).toEqual(new Set());
	});
});
