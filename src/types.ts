export type Mode = "single" | "multi";

export interface PlanSection {
	id: string;
	title: string;
	heading: string;
	chapter?: string;
	needs: string[];
	verify?: string;
	brief?: string;
	startLine: number;
	endLine: number;
	generatedId: boolean;
}

export interface PlanDocument {
	source: string;
	sections: PlanSection[];
	byId: Map<string, PlanSection>;
	chapters: string[];
	missingIds: string[];
	duplicateIds: string[];
	conflictLines: number[];
}

export interface ProgressState {
	active: string | null;
	attempts: number;
	done: string[];
	blocker: string[];
	tried: string[];
	next: string[];
	unknown: string[];
}

export interface GitState {
	available: boolean;
	head: string | null;
	dirtyPaths: string[];
	stagedPaths: string[];
	conflictPaths: string[];
	error?: string;
}

export interface RunState {
	runId: string;
	mode: Mode;
	startedAt: string;
	sectionId: string;
	baseHead: string | null;
	preexistingDirtyPaths: string[];
	pendingPaths: Map<string, string>;
	ownedPaths: Set<string>;
	unownedPaths: Set<string>;
	completedSections: string[];
	completed: boolean;
}

export interface ContextSnapshot {
	mode: Mode;
	plan: PlanDocument;
	progress: ProgressState;
	git: GitState;
	run: RunState | null;
	hints: string[];
	planPath: string;
	progressPath: string;
}
