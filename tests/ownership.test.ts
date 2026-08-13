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
});
