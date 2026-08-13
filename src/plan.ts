import type { PlanDocument, PlanSection } from "./types.js";

export class PlanError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PlanError";
	}
}

const CONFLICT_MARKERS = [/^<<<<<<<(?: .*)?$/m, /^=======$/m, /^>>>>>>>?(?: .*)?$/m];
const METADATA_PATTERN = /^<!--\s*(id|section-id|needs|verify|brief)\s*:\s*(.*?)\s*-->$/;

export interface PlanFence {
	marker: "`" | "~";
	length: number;
}

interface SourceLine {
	content: string;
	ending: string;
}

function splitSourceLines(source: string): SourceLine[] {
	const lines: SourceLine[] = [];
	const linePattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
	let match: RegExpExecArray | null;
	while ((match = linePattern.exec(source)) !== null) {
		const [raw, content, ending] = match;
		if (!raw && match.index === source.length) break;
		lines.push({ content, ending });
		if (!ending) break;
	}
	return lines;
}

function parseFence(line: string): PlanFence | null {
	const match = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
	if (!match) return null;
	return { marker: match[1][0] as "`" | "~", length: match[1].length };
}

function closesFence(line: string, fence: PlanFence): boolean {
	const match = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
	return match !== null && match[1][0] === fence.marker && match[1].length >= fence.length;
}

export function advancePlanFence(
	line: string,
	fence: PlanFence | null,
): { fence: PlanFence | null; fenced: boolean } {
	if (fence) {
		return closesFence(line, fence)
			? { fence: null, fenced: true }
			: { fence, fenced: true };
	}
	const opening = parseFence(line);
	return opening ? { fence: opening, fenced: true } : { fence: null, fenced: false };
}

function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^\p{Letter}\p{Number}]+/gu, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "section";
}

export function materializeMissingIds(source: string): { source: string; changed: boolean } {
	const lines = splitSourceLines(source);
	const defaultLineEnding = lines.find((line) => line.ending)?.ending ?? "\n";
	let result = "";
	let changed = false;
	let fence: PlanFence | null = null;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const fenceState = advancePlanFence(line.content, fence);
		fence = fenceState.fence;
		if (fenceState.fenced) {
			result += line.content + line.ending;
			continue;
		}

		let insertId: string | undefined;
		const sectionMatch = /^### (.+?)\s*$/.exec(line.content);
		if (sectionMatch) {
			let lookahead = index + 1;
			let hasId = false;
			while (lookahead < lines.length) {
				const nextLine = lines[lookahead].content;
				if (!nextLine.trim()) {
					lookahead += 1;
					continue;
				}
				const metadata = METADATA_PATTERN.exec(nextLine.trim());
				if (!metadata) break;
				if (metadata[1] === "id" || metadata[1] === "section-id") hasId = true;
				lookahead += 1;
			}
			if (!hasId) {
				const title = sectionMatch[1].replace(/^\d+(?:\.\d+)*\s+/, "").trim() || sectionMatch[1];
				insertId = `<!-- id: ${slugify(title)} -->`;
				changed = true;
			}
		}

		const lineEnding = line.ending || defaultLineEnding;
		if (insertId) {
			result += line.content + lineEnding + insertId + (line.ending ? lineEnding : "");
		} else {
			result += line.content + line.ending;
		}
	}
	return { source: result, changed };
}

function parseNeeds(value: string): string[] {
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

export function parsePlan(source: string): PlanDocument {
	const lines = source.split(/\r\n|\n|\r/);
	const conflictLines: number[] = [];
	const sections: PlanSection[] = [];
	const chapters: string[] = [];
	let currentChapter: string | undefined;
	let current: (Omit<PlanSection, "id" | "endLine" | "generatedId"> & { explicitId?: string; generatedId?: boolean }) | null = null;
	let fence: PlanFence | null = null;

	const finish = (endLine: number) => {
		if (!current) return;
		const id = current.explicitId?.trim() || slugify(current.title);
		sections.push({
			id,
			title: current.title,
			heading: current.heading,
			chapter: current.chapter,
			needs: current.needs,
			verify: current.verify,
			brief: current.brief,
			startLine: current.startLine,
			endLine,
			generatedId: !current.explicitId,
		});
	};

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const fenceState = advancePlanFence(line, fence);
		fence = fenceState.fence;
		if (fenceState.fenced) continue;
		if (CONFLICT_MARKERS.some((marker) => marker.test(line))) conflictLines.push(index + 1);
		const chapterMatch = /^(##) (?!#)(.+?)\s*$/.exec(line);
		if (chapterMatch) {
			finish(index);
			current = null;
			currentChapter = chapterMatch[2].trim();
			chapters.push(currentChapter);
			continue;
		}

		const sectionMatch = /^(###) (.+?)\s*$/.exec(line);
		if (sectionMatch) {
			finish(index);
			const heading = sectionMatch[2].trim();
			current = {
				title: heading.replace(/^\d+(?:\.\d+)*\s+/, "").trim() || heading,
				heading,
				chapter: currentChapter,
				needs: [],
				startLine: index + 1,
			};
			continue;
		}

		if (!current) continue;
		const metadata = METADATA_PATTERN.exec(line.trim());
		if (!metadata) continue;
		const [, key, rawValue] = metadata;
		if (key === "id" || key === "section-id") current.explicitId = rawValue;
		if (key === "needs") current.needs = parseNeeds(rawValue);
		if (key === "verify") current.verify = rawValue || undefined;
		if (key === "brief") current.brief = rawValue || undefined;
	}
		finish(lines.length);
	if (conflictLines.length > 0) {
		throw new PlanError(`plan.md contains git conflict markers at lines ${conflictLines.join(", ")}`);
	}

	const byId = new Map<string, PlanSection>();
	const duplicateIds = new Set<string>();
	for (const section of sections) {
		if (byId.has(section.id)) duplicateIds.add(section.id);
		byId.set(section.id, section);
	}
	if (duplicateIds.size > 0) {
		throw new PlanError(`duplicate section id: ${[...duplicateIds].sort()[0]}`);
	}

	return {
		source,
		sections,
		byId,
		chapters,
		missingIds: sections.filter((section) => section.generatedId).map((section) => section.id),
		duplicateIds: [...duplicateIds],
		conflictLines,
	};
}

export function buildPlanWorkingSet(plan: PlanDocument, activeId: string | null): PlanSection[] {
	if (!activeId) return plan.sections.slice(0, 3);
	const activeIndex = plan.sections.findIndex((section) => section.id === activeId);
	if (activeIndex < 0) return plan.sections.slice(0, 3);
	const selected = new Set<string>();
	for (const index of [activeIndex - 1, activeIndex, activeIndex + 1]) {
		if (index >= 0 && index < plan.sections.length) selected.add(plan.sections[index].id);
	}
	for (const dependency of plan.sections[activeIndex].needs) {
		if (plan.byId.has(dependency)) selected.add(dependency);
	}
	return plan.sections.filter((section) => selected.has(section.id));
}
