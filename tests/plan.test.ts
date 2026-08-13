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

	it("scans the complete metadata block before materializing an id and preserves mixed line endings", () => {
		const source =
			"### First\r\n" +
			"<!-- needs: dependency -->\n" +
			"\r\n" +
			"<!-- brief: first section -->\r\n" +
			"<!-- section-id: first -->\n" +
			"body\r\n" +
			"### Second\n" +
			"<!-- verify: npm test -->\r\n" +
			"body\n";

		const result = materializeMissingIds(source);

		expect(result.changed).toBe(true);
		expect(result.source).toBe(
			"### First\r\n" +
			"<!-- needs: dependency -->\n" +
			"\r\n" +
			"<!-- brief: first section -->\r\n" +
			"<!-- section-id: first -->\n" +
			"body\r\n" +
			"### Second\n" +
			"<!-- id: second -->\n" +
			"<!-- verify: npm test -->\r\n" +
			"body\n",
		);
	});

	it("ignores headings and metadata inside backtick and tilde fences", () => {
		const plan = parsePlan(
			[
				"### Real",
				"```markdown",
				"## Fake Chapter",
				"### Fake Section",
				"<!-- id: fake -->",
				"```",
				"~~~markdown",
				"### Another Fake Section",
				"<!-- id: another-fake -->",
				"~~~",
				"<!-- id: real -->",
				"body",
			].join("\n"),
		);

		expect(plan.sections).toHaveLength(1);
		expect(plan.sections[0]).toMatchObject({ id: "real", title: "Real", generatedId: false });
	});

	it("ignores Git conflict-looking text inside fenced examples", () => {
		const plan = parsePlan(
			[
				"### Real",
				"```diff",
				"<<<<<<< HEAD",
				"old example",
				"=======",
				"new example",
				">>>>>>> branch",
				"```",
				"<!-- id: real -->",
			].join("\n"),
		);

		expect(plan.sections).toHaveLength(1);
		expect(plan.sections[0].id).toBe("real");
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
