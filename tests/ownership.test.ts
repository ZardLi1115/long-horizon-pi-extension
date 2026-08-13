import { describe, expect, it } from "vitest";
import { OwnershipTracker } from "../src/ownership.js";

describe("ownership tracker", () => {
	it("owns write/edit paths only after successful tool results", () => {
		const tracker = new OwnershipTracker("/tmp/project");
		tracker.pending("call-1", "write", "src/file.ts");
		tracker.result("call-1", false);
		tracker.pending("call-2", "edit", "src/file.ts");
		tracker.result("call-2", true);

		expect(tracker.snapshot()).toEqual({
			owned: ["src/file.ts"],
			unowned: [],
			pending: [],
		});
	});

	it("owns both paths after a successful move and rejects outside paths", () => {
		const tracker = new OwnershipTracker("/tmp/project");
		tracker.customSuccess("move", ["src/old.ts", "src/new.ts"]);

		expect(tracker.snapshot().owned).toEqual(["src/new.ts", "src/old.ts"]);
		expect(() => tracker.pending("call", "write", "../outside.ts")).toThrow(/outside cwd/);
	});

	it("does not infer ownership from bash or arbitrary untracked paths", () => {
		const tracker = new OwnershipTracker("/tmp/project");
		tracker.markUnowned("generated/by-bash.txt");

		expect(tracker.snapshot()).toEqual({
			owned: [],
			unowned: ["generated/by-bash.txt"],
			pending: [],
		});
	});

	it("clears an unowned marker when a later owned tool succeeds", () => {
		const tracker = new OwnershipTracker("/tmp/project");
		tracker.markUnowned("generated/by-bash.txt");
		tracker.pending("call-1", "write", "generated/by-bash.txt");
		tracker.result("call-1", false);

		expect(tracker.snapshot()).toEqual({
			owned: ["generated/by-bash.txt"],
			unowned: [],
			pending: [],
		});
	});

	it("detects an owned file changed after a successful tool result", async () => {
		const tracker = new OwnershipTracker("/tmp/project");
		tracker.pending("call-1", "write", "src/file.ts");
		tracker.result("call-1", false, "before");

		expect(await tracker.validate(async () => "after")).toEqual(["src/file.ts"]);
		expect(await tracker.validate(async () => "before")).toEqual([]);
	});

	it("blocks a later acquisition after an external change instead of re-baselining it", () => {
		const tracker = new OwnershipTracker("/tmp/project");
		tracker.pending("call-1", "write", "src/file.ts");
		tracker.result("call-1", false, "agent-version-1");

		expect(() => tracker.assertCanAcquire("src/file.ts", "external-version")).toThrow(
		/owned path changed outside Long Horizon tools/,
		);
		expect(() => tracker.assertCanAcquire("src/file.ts", "agent-version-1")).not.toThrow();
	});

	it("records expected states for delete and move operations", async () => {
		const tracker = new OwnershipTracker("/tmp/project");
		tracker.customSuccess(
			"delete",
			["deleted.ts"],
			new Map<string, string | null>([["deleted.ts", null]]),
		);
		tracker.customSuccess(
			"move",
			["old.ts", "new.ts"],
			new Map<string, string | null>([
				["old.ts", null],
				["new.ts", "new-content"],
			]),
		);

		expect(await tracker.validate(async (filePath) => {
			if (filePath === "new.ts") return "new-content";
			return null;
		})).toEqual([]);
	});
});
