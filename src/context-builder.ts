import type { ContextSnapshot } from "./types.js";

export function buildStableProtocol(): string {
	return [
		"[Long-Horizon Protocol]",
		"Canonical state lives in plan.md, progress.md, and Git.",
		"Read the Long-Horizon Query Snapshot supplied at the start of this user query; do not invent a different active section.",
		"The Query Snapshot may be stale after tools run; use tool results for state changes, and rely on runtime checks for correctness.",
		"Use complete_section for a verified or explicitly unverified section completion.",
		"Only call record_attempt_failure after a concrete attempt has failed or a concrete approach has been abandoned; ordinary agent turns and verification failures do not increment attempts automatically.",
		"Use reopen_section when a completed section must be revisited.",
		"The default mode is single: one user query is locked to one active section and completion ends that agent loop.",
		"multi mode allows one query to continue into later sections, while each section still commits independently.",
		"Plan Cached Snapshot is the baseline. For the same section ID, the latest Plan Update wins. A deleted tombstone removes all earlier versions.",
		"Do not claim completion when verification fails, Git boundaries are ambiguous, or required state is malformed.",
	].join("\n");
}

export function buildDynamicContext(snapshot: ContextSnapshot): string {
	const run = snapshot.run;
	const lines = [
		"[Long-Horizon Query Snapshot]",
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
