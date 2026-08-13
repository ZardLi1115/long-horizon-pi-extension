import { createHash } from "node:crypto";
import { advancePlanFence, parsePlan, type PlanFence } from "./plan.js";
import type {
	PlanCacheDelta,
	PlanCacheDocument,
	PlanCacheManifest,
	PlanCacheSection,
	PlanSnapshotDetails,
	PlanUpdateDetails,
} from "./types.js";

interface SourceLine {
	start: number;
	content: string;
}

function sha256(source: string): string {
	return createHash("sha256").update(source, "utf8").digest("hex");
}

function splitSourceLines(source: string): SourceLine[] {
	const lines: SourceLine[] = [];
	const linePattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
	let match: RegExpExecArray | null;
	while ((match = linePattern.exec(source)) !== null) {
		const [raw, content, lineEnding] = match;
		if (!raw && match.index === source.length) break;
		lines.push({
			start: match.index,
			content,
		});
		if (!lineEnding) break;
	}
	return lines;
}

export function parsePlanCacheDocument(source: string): PlanCacheDocument {
	const plan = parsePlan(source);
	const lines = splitSourceLines(source);
	const boundaries: Array<{ line: SourceLine; index: number }> = [];
	let fence: PlanFence | null = null;
	for (const [index, line] of lines.entries()) {
		const fenceState = advancePlanFence(line.content, fence);
		fence = fenceState.fence;
		if (fenceState.fenced) continue;
		if (/^### (.+?)\s*$/.test(line.content) || /^## (?!#)(.+?)\s*$/.test(line.content)) {
			boundaries.push({ line, index });
		}
	}
	const sectionStarts = boundaries.filter(({ line }) => /^### (.+?)\s*$/.test(line.content));
	const sections = new Map<string, PlanCacheSection>();
	const structureParts: string[] = [];
	let structureCursor = 0;

	for (let index = 0; index < sectionStarts.length; index += 1) {
		const start = sectionStarts[index];
		const parsedSection = plan.sections[index];
		if (!parsedSection) throw new Error("plan section parsing produced inconsistent results");
		const nextBoundary = boundaries.find((boundary) => boundary.index > start.index);
		const end = nextBoundary ? nextBoundary.line.start : source.length;
		const sectionSource = source.slice(start.line.start, end);
		sections.set(parsedSection.id, {
			id: parsedSection.id,
			source: sectionSource,
			hash: sha256(sectionSource),
		});
		structureParts.push(source.slice(structureCursor, start.line.start));
		const trailingLineEnding = /(?:\r\n|\n|\r)$/.exec(sectionSource)?.[0] ?? "";
		structureParts.push(`<!-- section: ${parsedSection.id} -->${trailingLineEnding}`);
		structureCursor = end;
	}

	if (sectionStarts.length !== plan.sections.length) {
		throw new Error("plan section parsing produced inconsistent results");
	}
	structureParts.push(source.slice(structureCursor));
	const structureSource = structureParts.join("");

	return {
		source,
		planHash: sha256(source),
		structureSource,
		structureHash: sha256(structureSource),
		order: plan.sections.map((section) => section.id),
		sections,
	};
}

export function createPlanManifest(generationId: string, document: PlanCacheDocument): PlanCacheManifest {
	return {
		version: 1,
		generationId,
		planHash: document.planHash,
		structureHash: document.structureHash,
		order: [...document.order],
		sections: document.order.map((id) => {
			const section = document.sections.get(id);
			if (!section) throw new Error(`missing plan cache section: ${id}`);
			return { id, hash: section.hash };
		}),
	};
}

export function diffPlanCache(observed: PlanCacheManifest, current: PlanCacheDocument): PlanCacheDelta {
	const observedHashes = new Map(observed.sections.map((section) => [section.id, section.hash]));
	const changedIds = current.order.filter((id) => observedHashes.get(id) !== current.sections.get(id)?.hash);
	const deletedIds = observed.order.filter((id) => !current.sections.has(id));
	return {
		changedIds,
		deletedIds,
		structureChanged: observed.structureHash !== current.structureHash,
		current,
	};
}

export function hasPlanCacheDelta(delta: PlanCacheDelta): boolean {
	return delta.changedIds.length > 0 || delta.deletedIds.length > 0 || delta.structureChanged;
}

export function createSnapshotDetails(
	generationId: string,
	document: PlanCacheDocument,
): PlanSnapshotDetails {
	return {
		kind: "snapshot",
		...createPlanManifest(generationId, document),
	};
}

export function createUpdateDetails(
	generationId: string,
	delta: PlanCacheDelta,
): PlanUpdateDetails {
	return {
		kind: "update",
		...createPlanManifest(generationId, delta.current),
		changedIds: [...delta.changedIds],
		deletedIds: [...delta.deletedIds],
		structureChanged: delta.structureChanged,
	};
}

export function renderPlanSnapshot(document: PlanCacheDocument): string {
	return (
		"[Plan Cached Snapshot]\n\n" +
		"This is the canonical plan snapshot at the start of this cache generation.\n" +
		"Later Plan Updates override sections or structure appearing in this snapshot.\n\n" +
		document.source
	);
}

function joinMessageBlocks(blocks: string[]): string {
	let result = blocks[0] ?? "";
	for (const block of blocks.slice(1)) {
		if (/(?:\r\n|\n|\r){2}$/.test(result)) result += block;
		else if (/(?:\r\n|\n|\r)$/.test(result)) result += `\n${block}`;
		else result += `\n\n${block}`;
	}
	return result;
}

export function renderPlanUpdate(delta: PlanCacheDelta): string {
	const document = delta.current;
	const parts = [
		"[Plan Updates Since Cached Snapshot]\n\n" +
			"The following plan sections have changed.\n" +
			"These updates override any older versions appearing earlier in the prompt.",
	];

	for (const id of delta.changedIds) {
		const section = document.sections.get(id);
		if (!section) throw new Error(`missing changed plan section: ${id}`);
		parts.push(`## ${id}\n\n${section.source}`);
	}
	for (const id of delta.deletedIds) {
		parts.push(
			`## ${id}\n\n<!-- deleted: true -->\n\nThis section has been removed from the canonical plan.`,
		);
	}
	if (delta.structureChanged) {
		parts.push(`## __plan-structure__\n\n[Plan Structure Snapshot]\n\n${document.structureSource}`);
	}
	return joinMessageBlocks(parts);
}
