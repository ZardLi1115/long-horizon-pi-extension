import { describe, expect, it } from "vitest";
import { startRun, completeRunSection, canCompleteSection, syncRunPaths } from "../src/run.js";
import type { GitState, ProgressState } from "../src/types.js";

const git: GitState = { available: true, head: "abc", dirtyPaths: [], stagedPaths: [], conflictPaths: [] };
const cleanProgress: ProgressState = {
	active: "one",
	attempts: 0,
	done: [],
	blocker: [],
	tried: [],
	next: [],
	unknown: [],
};

describe("run state", () => {
	it("locks the active section without changing progress attempts", () => {
		const first = startRun("single", cleanProgress, git);
		const repeated = startRun("single", { ...cleanProgress, attempts: 2 }, git);
		const moved = startRun("single", { ...cleanProgress, active: "two", attempts: 4 }, git);

		expect(first.sectionId).toBe("one");
		expect(repeated.sectionId).toBe("one");
		expect(moved.sectionId).toBe("two");
		expect(repeated.baseHead).toBe("abc");
	});

	it("rejects cross-section completion in single mode", () => {
		const run = startRun("single", cleanProgress, git);

		expect(canCompleteSection(run, "two")).toMatchObject({ ok: false, error: /locked section/ });
		expect(canCompleteSection(run, "one")).toEqual({ ok: true });
	});

	it("records each completed section and allows multi mode to continue", () => {
		const run = startRun("multi", cleanProgress, git);
		const next = completeRunSection(run, "one", "two");

		expect(next.completedSections).toEqual(["one"]);
		expect(next.completed).toBe(false);
		expect(next.sectionId).toBe("two");
	});

	it("classifies new dirty paths as unowned unless the run explicitly owns them", () => {
		const run = startRun("single", cleanProgress, git);
		const synced = syncRunPaths(
			run,
			{ ...git, dirtyPaths: ["generated.txt", "src/owned.ts"] },
			new Set(["src/owned.ts"]),
		);

		expect([...synced.ownedPaths]).toEqual(["src/owned.ts"]);
		expect([...synced.unownedPaths]).toEqual(["generated.txt"]);
	});

	it("starts a new query with an empty completed-section history", () => {
		const previous = { ...startRun("multi", cleanProgress, git), completedSections: ["one"] };
		const next = startRun("multi", { ...cleanProgress, active: "two" }, git);

		expect(next.completedSections).toEqual([]);
	});
});
