import { describe, expect, it } from "vitest";
import {
	advanceProgress,
	incrementAttempt,
	parseProgress,
	reopenProgress,
	serializeProgress,
	withDefaultActive,
} from "../src/progress.js";

describe("progress state", () => {
	it("creates an empty state when progress is missing", () => {
		expect(parseProgress("")).toEqual({
			active: null,
			attempts: 0,
			done: [],
			blocker: [],
			tried: [],
			next: [],
			unknown: [],
		});
	});

	it("round trips the bounded fields in canonical order", () => {
		const state = parseProgress(
			[
				"active: sec-active",
				"attempts: 2",
				"",
				"done:",
				"  - sec-one",
				"blocker:",
				"  - refresh race",
				"tried:",
				"  - optimistic lock",
				"next:",
				"  - run auth tests",
			].join("\n"),
		);

		expect(serializeProgress(state)).toBe(
			[
				"active: sec-active",
				"attempts: 2",
				"",
				"done:",
				"  - sec-one",
				"",
				"blocker:",
				"  - refresh race",
				"",
				"tried:",
				"  - optimistic lock",
				"",
				"next:",
				"  - run auth tests",
				"",
			].join("\n"),
		);
	});

	it("preserves unknown top-level lines without interpreting them", () => {
		const state = parseProgress("active: one\ncustom: keep me\n  - not parsed");

		expect(state.unknown).toEqual(["custom: keep me", "  - not parsed"]);
		expect(serializeProgress(state)).toContain("custom: keep me\n  - not parsed");
	});

	it("advances to the next unfinished section and resets local state", () => {
		const state = parseProgress("active: one\nattempts: 3\ndone:\n  - one\n  - two\nblocker:\n  - old\ntried:\n  - old attempt");

		expect(advanceProgress(state, ["one", "two", "three"])).toEqual({
			active: "three",
			attempts: 0,
			done: ["one", "two"],
			blocker: [],
			tried: [],
			next: [],
			unknown: [],
		});
	});

	it("increments attempts immutably and reopens a completed section", () => {
		const original = parseProgress("active: current\nattempts: 1\ndone:\n  - old");
		const attempted = incrementAttempt(original, "verify failed");
		const reopened = reopenProgress(original, "old", "regression found");

		expect(attempted).toMatchObject({ active: "current", attempts: 2, blocker: ["verify failed"] });
		expect(reopened).toMatchObject({ active: "old", attempts: 0, done: [], blocker: ["regression found"] });
		expect(original).toMatchObject({ active: "current", attempts: 1, done: ["old"] });
	});

	it("preserves unknown fields while advancing progress", () => {
		const state = parseProgress("active: one\ncustom: keep me");

		expect(advanceProgress(state, ["one", "two"]).unknown).toEqual(["custom: keep me"]);
	});

	it("selects the first unfinished section when active is absent", () => {
		const state = parseProgress("done:\n  - one");

		expect(withDefaultActive(state, ["one", "two", "three"]).active).toBe("two");
	});
});
