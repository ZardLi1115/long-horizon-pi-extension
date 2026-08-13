import { describe, expect, it } from "vitest";
import { startRun, completeRunSection, canCompleteSection, prepareProgressForRun, syncRunPaths } from "../src/run.js";
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
	it("locks the active section and increments attempts only when it repeats", () => {
		const first = startRun("single", cleanProgress, git, null);
		const repeated = startRun("single", { ...cleanProgress, attempts: 2 }, git, first);
		const moved = startRun("single", { ...cleanProgress, active: "two", attempts: 4 }, git, repeated);

		expect(first.sectionId).toBe("one");
		expect(repeated.sectionId).toBe("one");
		expect(moved.sectionId).toBe("two");
	});

	it("rejects cross-section completion in single mode", () => {
		const run = startRun("single", cleanProgress, git, null);

		expect(canCompleteSection(run, "two")).toMatchObject({ ok: false, error: /locked section/ });
		expect(canCompleteSection(run, "one")).toEqual({ ok: true });
	});

	it("records each completed section and allows multi mode to continue", () => {
		const run = startRun("multi", cleanProgress, git, null);
		const next = completeRunSection(run, "one", "two");

		expect(next.completedSections).toEqual(["one"]);
		expect(next.completed).toBe(false);
		expect(next.sectionId).toBe("two");
	});

	it("increments attempts for a repeated active section and resets them after active moves", () => {
		const first = startRun("single", cleanProgress, git, null);
		const repeated = prepareProgressForRun({ ...cleanProgress, attempts: 2 }, first);
		const moved = prepareProgressForRun({ ...cleanProgress, active: "two", attempts: 4 }, first);

		expect(repeated.progress.attempts).toBe(3);
		expect(moved.progress.attempts).toBe(1);
	});

	it("classifies new dirty paths as unowned unless the run explicitly owns them", () => {
		const run = startRun("single", cleanProgress, git, null);
		const synced = syncRunPaths(
			run,
			{ ...git, dirtyPaths: ["generated.txt", "src/owned.ts"] },
			new Set(["src/owned.ts"]),
		);

		expect([...synced.ownedPaths]).toEqual(["src/owned.ts"]);
		expect([...synced.unownedPaths]).toEqual(["generated.txt"]);
	});

	it("starts a new query with an empty completed-section history", () => {
		const previous = { ...startRun("multi", cleanProgress, git, null), completedSections: ["one"] };
		const next = startRun("multi", { ...cleanProgress, active: "two" }, git, previous);

		expect(next.completedSections).toEqual([]);
	});
});
