import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	createPlanManifest,
	createSnapshotDetails,
	createUpdateDetails,
	diffPlanCache,
	hasPlanCacheDelta,
	parsePlanCacheDocument,
	renderPlanSnapshot,
	renderPlanUpdate,
} from "../src/plan-cache.js";
import type { PlanCacheManifest } from "../src/types.js";

function sha256(source: string): string {
	return createHash("sha256").update(source, "utf8").digest("hex");
}

describe("plan cache document", () => {
	it("preserves exact UTF-8 section bytes, trailing spaces, CRLF, and multiple sections", () => {
		const source =
			"# 计划\r\n\r\n## 核心\r\nchapter text  \r\n" +
			"### 1.1 核心接口  \r\n<!-- id: sec-core -->\r\n正文尾空格  \r\n\r\n" +
			"### 1.2 刷新令牌\r\n<!-- id: sec-refresh -->\r\n最后一行\r\n";
		const firstSource = "### 1.1 核心接口  \r\n<!-- id: sec-core -->\r\n正文尾空格  \r\n\r\n";
		const secondSource = "### 1.2 刷新令牌\r\n<!-- id: sec-refresh -->\r\n最后一行\r\n";
		const structureSource =
			"# 计划\r\n\r\n## 核心\r\nchapter text  \r\n" +
			"<!-- section: sec-core -->\r\n<!-- section: sec-refresh -->\r\n";

		const document = parsePlanCacheDocument(source);

		expect(document.source).toBe(source);
		expect(document.planHash).toBe(sha256(source));
		expect(document.order).toEqual(["sec-core", "sec-refresh"]);
		expect(document.sections.get("sec-core")).toEqual({
			id: "sec-core",
			source: firstSource,
			hash: sha256(firstSource),
		});
		expect(document.sections.get("sec-refresh")).toEqual({
			id: "sec-refresh",
			source: secondSource,
			hash: sha256(secondSource),
		});
		expect(document.structureSource).toBe(structureSource);
		expect(document.structureHash).toBe(sha256(structureSource));
	});

	it("reuses plan validation for duplicate ids and conflict markers", () => {
		expect(() =>
			parsePlanCacheDocument("### One\n<!-- id: same -->\n### Two\n<!-- id: same -->"),
		).toThrow("duplicate section id: same");
		expect(() =>
			parsePlanCacheDocument("### One\n<!-- id: one -->\n<<<<<<< HEAD\nold\n=======\nnew\n>>>>>>> branch"),
		).toThrow(/plan\.md contains git conflict markers/);
	});

	it("keeps a deterministic placeholder for a final section without a trailing newline", () => {
		const document = parsePlanCacheDocument("# Plan\n\n### Last\n<!-- id: last -->\nbody");

		expect(document.sections.get("last")?.source).toBe("### Last\n<!-- id: last -->\nbody");
		expect(document.structureSource).toBe("# Plan\n\n<!-- section: last -->");
	});

	it("ends a section before the next chapter and keeps the chapter in the structure skeleton", () => {
		const document = parsePlanCacheDocument(
			"## First Chapter\n\n### A\n<!-- id: a -->\nA body\n\n## Second Chapter\nchapter text\n\n### B\n<!-- id: b -->\nB body\n",
		);

		expect(document.sections.get("a")?.source).toBe("### A\n<!-- id: a -->\nA body\n\n");
		expect(document.sections.get("b")?.source).toBe("### B\n<!-- id: b -->\nB body\n");
		expect(document.structureSource).toBe(
			"## First Chapter\n\n<!-- section: a -->\n## Second Chapter\nchapter text\n\n<!-- section: b -->\n",
		);
	});

	it("ignores fenced headings and metadata when building the cache structure", () => {
		const source =
			"# Plan\n\n" +
			"### Real\n" +
			"```markdown\n" +
			"## Fake Chapter\n" +
			"### Fake Section\n" +
			"<!-- id: fake -->\n" +
			"```\n" +
			"~~~markdown\n" +
			"### Another Fake Section\n" +
			"<!-- id: another-fake -->\n" +
			"~~~\n" +
			"<!-- id: real -->\n" +
			"body\n";
		const document = parsePlanCacheDocument(source);

		expect(document.order).toEqual(["real"]);
		expect(document.sections.get("real")?.source).toBe(source.slice(source.indexOf("### Real")));
		expect(document.structureSource).toBe("# Plan\n\n<!-- section: real -->\n");
	});
});

describe("plan cache diff", () => {
	it("orders changed ids by current order and deleted ids by observed order", () => {
		const observed = createPlanManifest(
			"generation-1",
			parsePlanCacheDocument(
				"### Old A\n<!-- id: a -->\nold-a\n### Deleted D\n<!-- id: d -->\ndeleted\n### Old B\n<!-- id: b -->\nold-b",
			),
		);
		const current = parsePlanCacheDocument(
			"### New B\n<!-- id: b -->\nnew-b\n### Added C\n<!-- id: c -->\nnew-c\n### New A\n<!-- id: a -->\nnew-a",
		);

		const delta = diffPlanCache(observed, current);

		expect(delta).toEqual({
			changedIds: ["b", "c", "a"],
			deletedIds: ["d"],
			structureChanged: true,
			current,
		});
		expect(hasPlanCacheDelta(delta)).toBe(true);
	});

	it("treats an id rename as a deletion and an addition", () => {
		const observed = createPlanManifest(
			"generation-1",
			parsePlanCacheDocument("### Item\n<!-- id: old-id -->\nbody"),
		);
		const current = parsePlanCacheDocument("### Item\n<!-- id: new-id -->\nbody");

		expect(diffPlanCache(observed, current)).toEqual({
			changedIds: ["new-id"],
			deletedIds: ["old-id"],
			structureChanged: true,
			current,
		});
	});

	it("diffs against only the latest input when a section changed repeatedly", () => {
		const observed = createPlanManifest(
			"generation-1",
			parsePlanCacheDocument("### Item\n<!-- id: item -->\nversion 1"),
		);
		const latest = parsePlanCacheDocument("### Item\n<!-- id: item -->\nversion 3");
		const delta = diffPlanCache(observed, latest);

		expect(delta.changedIds).toEqual(["item"]);
		expect(renderPlanUpdate(delta)).toContain(
			"### Item\n<!-- id: item -->\nversion 3",
		);
		expect(renderPlanUpdate(delta)).not.toContain("version 2");
	});

	it("continues from the latest update manifest without replaying an older version", () => {
		const first = parsePlanCacheDocument("### Item\n<!-- id: item -->\nversion 1\n");
		const second = parsePlanCacheDocument("### Item\n<!-- id: item -->\nversion 2\n");
		const third = parsePlanCacheDocument("### Item\n<!-- id: item -->\nversion 3\n");
		const firstManifest = createPlanManifest("generation-1", first);
		const secondDelta = diffPlanCache(firstManifest, second);
		const secondManifest = createPlanManifest("generation-1", secondDelta.current);
		const thirdDelta = diffPlanCache(secondManifest, third);

		expect(thirdDelta.changedIds).toEqual(["item"]);
		expect(renderPlanUpdate(thirdDelta)).toContain("version 3");
		expect(renderPlanUpdate(thirdDelta)).not.toContain("version 2");
	});

	it("detects structure text and section order changes without marking unchanged sections", () => {
		const first = parsePlanCacheDocument(
			"# Plan\n\nBefore\n\n### A\n<!-- id: a -->\nbody-a\n### B\n<!-- id: b -->\nbody-b\n",
		);
		const textChanged = parsePlanCacheDocument(
			"# Plan\n\nAfter\n\n### A\n<!-- id: a -->\nbody-a\n### B\n<!-- id: b -->\nbody-b\n",
		);
		const reordered = parsePlanCacheDocument(
			"# Plan\n\nBefore\n\n### B\n<!-- id: b -->\nbody-b\n### A\n<!-- id: a -->\nbody-a\n",
		);

		expect(diffPlanCache(createPlanManifest("generation-1", first), textChanged)).toEqual({
			changedIds: [],
			deletedIds: [],
			structureChanged: true,
			current: textChanged,
		});
		expect(diffPlanCache(createPlanManifest("generation-1", first), reordered)).toEqual({
			changedIds: [],
			deletedIds: [],
			structureChanged: true,
			current: reordered,
		});
	});

	it("returns an empty delta for an identical document", () => {
		const document = parsePlanCacheDocument("### A\n<!-- id: a -->\nbody  \n");
		const delta = diffPlanCache(createPlanManifest("generation-1", document), document);

		expect(delta).toEqual({ changedIds: [], deletedIds: [], structureChanged: false, current: document });
		expect(hasPlanCacheDelta(delta)).toBe(false);
	});

	it("orders deleted ids by the manifest order field", () => {
		const observed: PlanCacheManifest = {
			version: 1,
			generationId: "generation-1",
			planHash: "plan-hash",
			structureHash: "structure-hash",
			order: ["first", "second"],
			sections: [
				{ id: "second", hash: "second-hash" },
				{ id: "first", hash: "first-hash" },
			],
		};
		const current = parsePlanCacheDocument("### Current\n<!-- id: current -->\nbody\n");

		expect(diffPlanCache(observed, current).deletedIds).toEqual(["first", "second"]);
	});
});

describe("plan cache details and rendering", () => {
	it("creates deterministic snapshot text and details without a timestamp", () => {
		const source = "# Plan\n\n### A\n<!-- id: a -->\nbody";
		const document = parsePlanCacheDocument(source);
		const manifest = createPlanManifest("generation-1", document);
		expect(manifest).toEqual({
			version: 1,
			generationId: "generation-1",
			planHash: document.planHash,
			structureHash: document.structureHash,
			order: ["a"],
			sections: [{ id: "a", hash: document.sections.get("a")?.hash }],
		});

		expect(renderPlanSnapshot(document)).toBe(
			"[Plan Cached Snapshot]\n\n" +
				"This is the canonical plan snapshot at the start of this cache generation.\n" +
				"Later Plan Updates override sections or structure appearing in this snapshot.\n\n" +
				source,
		);
		expect(createSnapshotDetails("generation-1", document)).toEqual({
			kind: "snapshot",
			...manifest,
		});
	});

	it("renders full changed sections, deletion tombstones, and the complete structure last", () => {
		const observed = createPlanManifest(
			"generation-1",
			parsePlanCacheDocument(
				"# Old\n\n### A\n<!-- id: a -->\nold\n### Removed\n<!-- id: removed -->\ngone",
			),
		);
		const current = parsePlanCacheDocument(
			"# New\n\n### A\n<!-- id: a -->\nnew\n### Added\n<!-- id: added -->\nadded-body",
		);
		const delta = diffPlanCache(observed, current);

		expect(renderPlanUpdate(delta)).toBe(
			"[Plan Updates Since Cached Snapshot]\n\n" +
				"The following plan sections have changed.\n" +
				"These updates override any older versions appearing earlier in the prompt.\n\n" +
				"## a\n\n" +
				"### A\n<!-- id: a -->\nnew\n\n" +
				"## added\n\n" +
				"### Added\n<!-- id: added -->\nadded-body\n\n" +
				"## removed\n\n" +
				"<!-- deleted: true -->\n\n" +
				"This section has been removed from the canonical plan.\n\n" +
				"## __plan-structure__\n\n" +
				"[Plan Structure Snapshot]\n\n" +
				current.structureSource,
		);
	});

	it("stores the complete current manifest in update details", () => {
		const observed = createPlanManifest(
			"generation-1",
			parsePlanCacheDocument("### A\n<!-- id: a -->\nold\n### Removed\n<!-- id: removed -->\ngone"),
		);
		const current = parsePlanCacheDocument(
			"### Added\n<!-- id: added -->\nnew\n### A\n<!-- id: a -->\nchanged",
		);
		const delta = diffPlanCache(observed, current);

		expect(createUpdateDetails("generation-1", delta)).toEqual({
			kind: "update",
			...createPlanManifest("generation-1", current),
			changedIds: ["added", "a"],
			deletedIds: ["removed"],
			structureChanged: true,
		});
	});
});
