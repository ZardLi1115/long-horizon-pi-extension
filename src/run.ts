import { randomUUID } from "node:crypto";
import type { GitState, Mode, ProgressState, RunState } from "./types.js";

export interface CompletionCheck {
	ok: boolean;
	error?: string;
}

export function startRun(
	mode: Mode,
	progress: ProgressState,
	git: GitState,
): RunState {
	const sectionId = progress.active ?? "";
	return {
		runId: randomUUID(),
		mode,
		startedAt: new Date().toISOString(),
		sectionId,
		baseHead: git.head,
		pendingPaths: new Map(),
		ownedPaths: new Set(),
		unownedPaths: new Set(),
		completedSections: [],
		completed: false,
	};
}

export function syncRunPaths(run: RunState, git: GitState, ownedPaths: Set<string>): RunState {
	const dirty = new Set([...git.dirtyPaths, ...git.stagedPaths]);
	const unownedPaths = new Set<string>();
	for (const filePath of dirty) {
		if (!ownedPaths.has(filePath)) unownedPaths.add(filePath);
	}
	return { ...run, ownedPaths: new Set(ownedPaths), unownedPaths };
}

export function canCompleteSection(run: RunState, id: string): CompletionCheck {
	if (!run.sectionId) return { ok: false, error: "no active section is locked for this run" };
	if (id !== run.sectionId) return { ok: false, error: `section is not the locked section: ${run.sectionId}` };
	return { ok: true };
}

export function completeRunSection(run: RunState, id: string, nextSectionId: string | null): RunState {
	const check = canCompleteSection(run, id);
	if (!check.ok) throw new Error(check.error);
	const completedSections = [...new Set([...run.completedSections, id])];
	if (run.mode === "single") {
		return { ...run, completedSections, completed: true };
	}
	return {
		...run,
		sectionId: nextSectionId ?? "",
		completedSections,
		completed: nextSectionId === null,
	};
}
