import { describe, expect, it } from "vitest";
import { buildDynamicContext, buildStableProtocol } from "../src/context-builder.js";
import { parsePlan } from "../src/plan.js";
import type { ContextSnapshot, GitState, ProgressState, RunState } from "../src/types.js";

const progress: ProgressState = {
	active: "active",
	attempts: 2,
	done: ["first"],
	blocker: ["previous verify failed"],
	tried: ["old approach"],
	next: ["run the focused test"],
	unknown: [],
};

const git: GitState = {
	available: true,
	head: "abc123",
	dirtyPaths: ["generated.txt", "src/owned.ts"],
	stagedPaths: [],
	conflictPaths: [],
};

const run: RunState = {
	runId: "run-1",
	mode: "single",
	startedAt: "2026-08-13T00:00:00.000Z",
	sectionId: "active",
	baseHead: "abc123",
	pendingPaths: new Map(),
	ownedPaths: new Set(["src/owned.ts"]),
	unownedPaths: new Set(["generated.txt"]),
	completedSections: [],
	completed: false,
};

function snapshot(overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
	return {
		mode: "single",
		plan: parsePlan(
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
		),
		progress,
		git,
		run,
		hints: [],
		planPath: "plan.md",
		progressPath: "progress.md",
		...overrides,
	};
}

describe("context builder", () => {
	it("keeps stable protocol rules separate from dynamic project state", () => {
		const stable = buildStableProtocol();

		expect(stable).toContain("complete_section");
		expect(stable).toContain("record_attempt_failure");
		expect(stable).toContain("single");
		expect(stable).toContain("multi");
		expect(stable).toContain("plan.md");
		expect(stable).not.toContain("abc123");

		const dynamic = buildDynamicContext(snapshot());
		expect(dynamic).toContain("abc123");
		expect(dynamic).toContain("active");
		expect(dynamic).toContain("src/owned.ts");
	});

	it("keeps plan content out of the high-frequency dynamic tail", () => {
		const largePlan = parsePlan(
			[
				"### First\n<!-- id: first -->",
				"### Active\n<!-- id: active -->",
				"### Last\n<!-- id: last -->",
				...Array.from({ length: 20 }, (_, index) => `### Far ${index}\n<!-- id: far-${index} -->`),
			].join("\n"),
		);
		const dynamic = buildDynamicContext(snapshot({ plan: largePlan }));

		expect(dynamic).not.toContain("## Plan working set");
		expect(dynamic).not.toContain("id: active");
		expect(dynamic).not.toContain("id: far-19");
		expect(dynamic).toContain("## Active position");
		expect(dynamic).toContain("## Git state");
	});

	it("defines snapshot update and tombstone precedence in the stable protocol", () => {
		const stable = buildStableProtocol();

		expect(stable).toContain("Plan Cached Snapshot is the baseline");
		expect(stable).toContain("latest Plan Update wins");
		expect(stable).toContain("deleted tombstone");
	});

	it("renders recovery hints for malformed state and verification failures", () => {
		const dynamic = buildDynamicContext(
			snapshot({
				hints: ["active section is missing from plan.md", "plan.md contains duplicate section ids", "Git is unavailable"],
				git: { available: false, head: null, dirtyPaths: [], stagedPaths: [], conflictPaths: [] },
			}),
		);

		expect(dynamic).toContain("active section is missing from plan.md");
		expect(dynamic).toContain("plan.md contains duplicate section ids");
		expect(dynamic).toContain("Git is unavailable");
		expect(dynamic).toContain("previous verify failed");
	});

	it("still renders bootstrap context when no active section or run exists", () => {
		const dynamic = buildDynamicContext(
			snapshot({
				progress: { ...progress, active: null },
				run: null,
				hints: ["progress.md has no active section; choose one before editing"],
			}),
		);

		expect(dynamic).toContain("active: <none>");
		expect(dynamic).toContain("progress.md has no active section; choose one before editing");
	});
});
