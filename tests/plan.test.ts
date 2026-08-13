import { describe, expect, it } from "vitest";
import { PlanError, buildPlanWorkingSet, materializeMissingIds, parsePlan } from "../src/plan.js";

describe("plan parser", () => {
	it("reads section metadata and keeps display headings separate from ids", () => {
		const plan = parsePlan(`# Project\n\n## Auth\n\n### 3.2 Refresh Token Flow\n<!-- id: sec-refresh-token -->\n<!-- needs: sec-auth-api, sec-user-schema -->\n<!-- verify: npm test -- test/auth -->\n<!-- brief: rotate refresh tokens -->\n\n### 3.3 Logout\n<!-- section-id: sec-logout -->`);

		expect(plan.sections).toHaveLength(2);
		expect(plan.sections[0]).toMatchObject({
		id: "sec-refresh-token",
		needs: ["sec-auth-api", "sec-user-schema"],
		verify: "npm test -- test/auth",
		brief: "rotate refresh tokens",
		chapter: "Auth",
		generatedId: false,
		startLine: 5,
	});
		expect(plan.sections[1].id).toBe("sec-logout");
	});

	it("generates a stable slug for a section without an id", () => {
		const plan = parsePlan("### Refresh Token Flow\nbody");

		expect(plan.sections[0]).toMatchObject({
		id: "refresh-token-flow",
		generatedId: true,
	});
		expect(plan.missingIds).toEqual(["refresh-token-flow"]);
	});

	it("materializes generated ids immediately after their headings", () => {
		const result = materializeMissingIds("### Refresh Token Flow\nbody\n\n### Logout");

		expect(result.changed).toBe(true);
		expect(result.source).toBe(
			"### Refresh Token Flow\n<!-- id: refresh-token-flow -->\nbody\n\n### Logout\n<!-- id: logout -->",
		);
		expect(parsePlan(result.source).missingIds).toEqual([]);
	});

	it("does not insert a second id when existing metadata is separated by blank lines", () => {
		const result = materializeMissingIds("### Refresh Token Flow\n\n<!-- id: refresh-token-flow -->\nbody");

		expect(result.changed).toBe(false);
		expect(result.source).toBe("### Refresh Token Flow\n\n<!-- id: refresh-token-flow -->\nbody");
	});

	it("rejects duplicate ids and conflict markers", () => {
		expect(() => parsePlan("### One\n<!-- id: same -->\n### Two\n<!-- id: same -->")).toThrow(
		new PlanError("duplicate section id: same"),
		);

		expect(() => parsePlan("### One\n<<<<<<< HEAD\nold\n=======\nnew\n>>>>>>> branch")).toThrow(
		/plan\.md contains git conflict markers/,
		);
	});

	it("builds an active working set with neighbors and direct dependencies", () => {
		const plan = parsePlan(
			[
				"## Chapter",
				"### First",
				"<!-- id: first -->",
				"### Active",
				"<!-- id: active -->",
				"<!-- needs: dependency -->",
				"### Dependency",
				"<!-- id: dependency -->",
				"### Last",
				"<!-- id: last -->",
			].join("\n"),
		);

		expect(buildPlanWorkingSet(plan, "active").map((section) => section.id)).toEqual([
			"first",
			"active",
			"dependency",
		]);
	});
});
