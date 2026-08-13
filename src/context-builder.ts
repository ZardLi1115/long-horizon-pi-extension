import { buildPlanWorkingSet } from "./plan.js";
import type { ContextSnapshot } from "./types.js";

export function buildStableProtocol(): string {
	return [
		"[Long-Horizon Protocol]",
		"Canonical state lives in plan.md, progress.md, and Git.",
		"Read the dynamic state supplied before each model call; do not invent a different active section.",
		"Use complete_section for a verified or explicitly unverified section completion.",
		"Use reopen_section when a completed section must be revisited.",
		"The default mode is single: one user query is locked to one active section and completion ends that agent loop.",
		"multi mode allows one query to continue into later sections, while each section still commits independently.",
		"Do not claim completion when verification fails, Git boundaries are ambiguous, or required state is malformed.",
	].join("\n");
}

function renderSection(section: ContextSnapshot["plan"]["sections"][number]): string {
	const metadata = [
		`id: ${section.id}`,
		section.needs.length > 0 ? `needs: ${section.needs.join(", ")}` : "",
		section.verify ? `verify: ${section.verify}` : "",
		section.brief ? `brief: ${section.brief}` : "",
	].filter(Boolean);
	return [`### ${section.heading}`, ...metadata.map((line) => `<!-- ${line} -->`)].join("\n");
}

export function buildDynamicContext(snapshot: ContextSnapshot): string {
	const sections = buildPlanWorkingSet(snapshot.plan, snapshot.progress.active);
	const run = snapshot.run;
	const lines = [
		"[Long-Horizon Dynamic State]",
		`mode: ${snapshot.mode}`,
		`plan: ${snapshot.planPath}`,
		`progress: ${snapshot.progressPath}`,
		"",
		"## Active position",
		`active: ${snapshot.progress.active ?? "<none>"}`,
		`attempts: ${snapshot.progress.attempts}`,
		`run section lock: ${run?.sectionId || "<none>"}`,
		`done: ${snapshot.progress.done.join(", ") || "<none>"}`,
		`blocker: ${snapshot.progress.blocker.join(" | ") || "<none>"}`,
		`tried: ${snapshot.progress.tried.join(" | ") || "<none>"}`,
		`next: ${snapshot.progress.next.join(" | ") || "<none>"}`,
		"",
		"## Plan working set",
		...sections.map(renderSection),
		"",
		"## Git state",
		`snapshot head: ${snapshot.git.head ?? "<unavailable>"}`,
		`dirty: ${snapshot.git.dirtyPaths.join(", ") || "<none>"}`,
		`staged: ${snapshot.git.stagedPaths.join(", ") || "<none>"}`,
		`conflicts: ${snapshot.git.conflictPaths.join(", ") || "<none>"}`,
		`run owned: ${run ? [...run.ownedPaths].sort().join(", ") || "<none>" : "<none>"}`,
		`run unowned: ${run ? [...run.unownedPaths].sort().join(", ") || "<none>" : "<none>"}`,
	];
	if (snapshot.hints.length > 0) {
		lines.push("", "## Recovery hints", ...snapshot.hints.map((hint) => `- ${hint}`));
	}
	return lines.join("\n");
}
