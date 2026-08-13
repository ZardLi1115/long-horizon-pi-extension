import type { PlanDocument, PlanSection } from "./types.js";

export class PlanError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PlanError";
	}
}

const CONFLICT_MARKERS = [/^<<<<<<<(?: .*)?$/m, /^=======$/m, /^>>>>>>>?(?: .*)?$/m];
const METADATA_PATTERN = /^<!--\s*(id|section-id|needs|verify|brief)\s*:\s*(.*?)\s*-->$/;

function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^\p{Letter}\p{Number}]+/gu, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "section";
}

export function materializeMissingIds(source: string): { source: string; changed: boolean } {
	const lines = source.split(/\r?\n/);
	const result: string[] = [];
	let changed = false;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		result.push(line);
		const sectionMatch = /^### (.+?)\s*$/.exec(line);
		if (!sectionMatch) continue;
		let lookahead = index + 1;
		while (lookahead < lines.length && !lines[lookahead].trim()) lookahead += 1;
		const nextLine = lines[lookahead]?.trim() ?? "";
		if (/^<!--\s*(?:id|section-id)\s*:/.test(nextLine)) continue;
		const title = sectionMatch[1].replace(/^\d+(?:\.\d+)*\s+/, "").trim() || sectionMatch[1];
		result.push(`<!-- id: ${slugify(title)} -->`);
		changed = true;
	}
	return { source: result.join("\n"), changed };
}

function parseNeeds(value: string): string[] {
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

export function parsePlan(source: string): PlanDocument {
	const lines = source.split(/\r?\n/);
	const conflictLines = lines
		.map((line, index) => ({ line, index: index + 1 }))
		.filter(({ line }) => CONFLICT_MARKERS.some((marker) => marker.test(line)))
		.map(({ index }) => index);
	if (conflictLines.length > 0) {
		throw new PlanError(`plan.md contains git conflict markers at lines ${conflictLines.join(", ")}`);
	}

	const sections: PlanSection[] = [];
	const chapters: string[] = [];
	let currentChapter: string | undefined;
	let current: (Omit<PlanSection, "id" | "endLine" | "generatedId"> & { explicitId?: string; generatedId?: boolean }) | null = null;

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
