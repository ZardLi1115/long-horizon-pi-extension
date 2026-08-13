import { advanceProgress, reopenProgress } from "./progress.js";
import { canCompleteSection, completeRunSection } from "./run.js";
import type { GitState, PlanDocument, ProgressState, RunState } from "./types.js";
import type { CommitPathSelection } from "./git.js";

export interface VerifyResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface SectionOperationResult {
	ok: boolean;
	status: "verified" | "unverified" | "verify_failed" | "rejected" | "commit_failed";
	message: string;
	progress: ProgressState;
	run: RunState;
	commitPaths?: string[];
}

export interface CompleteSectionInput {
	id: string;
	verify?: string;
	skipVerify?: boolean;
	note?: string;
	run: RunState;
	plan: PlanDocument;
	progress: ProgressState;
	git: GitState;
	runVerify?: (command: string) => Promise<VerifyResult>;
	persistProgress: (state: ProgressState) => Promise<void>;
	refreshGit?: () => Promise<GitState>;
	selectCommitPaths: (git: GitState, run: RunState, pluginTouchedPaths: string[]) => CommitPathSelection;
	commit: (paths: string[], message: string) => Promise<void>;
	abort: () => void;
	pluginTouchedPaths?: string[];
	validateOwnedPaths?: () => Promise<string[]>;
}

export interface ReopenSectionInput {
	id: string;
	reason?: string;
	plan: PlanDocument;
	progress: ProgressState;
	persistProgress: (state: ProgressState) => Promise<void>;
}

export interface RecordAttemptFailureInput {
	id: string;
	tried: string;
	blocker: string;
	next: string;
	progress: ProgressState;
	persistProgress: (state: ProgressState) => Promise<void>;
}

export interface RecordAttemptFailureResult {
	ok: boolean;
	progress: ProgressState;
	message: string;
}

const MAX_VERIFY_OUTPUT = 1200;

function truncate(value: string): string {
	const text = value.trim();
	return text.length > MAX_VERIFY_OUTPUT ? `${text.slice(-MAX_VERIFY_OUTPUT)}…` : text;
}

function orderedIds(plan: PlanDocument): string[] {
	return plan.sections.map((section) => section.id);
}

export async function completeSection(input: CompleteSectionInput): Promise<SectionOperationResult> {
	const check = canCompleteSection(input.run, input.id);
	if (!check.ok) {
		return {
			ok: false,
			status: "rejected",
			message: check.error ?? "section is not available for completion",
			progress: input.progress,
			run: input.run,
		};
	}
	if (!input.plan.byId.has(input.id)) {
		return { ok: false, status: "rejected", message: `unknown section id: ${input.id}`, progress: input.progress, run: input.run };
	}
	if (input.progress.active !== input.run.sectionId) {
		return {
			ok: false,
			status: "rejected",
			message: `active section changed outside this run: expected ${input.run.sectionId}, found ${input.progress.active ?? "<none>"}`,
			progress: input.progress,
			run: input.run,
		};
	}

	if (input.verify !== undefined && input.skipVerify !== undefined) {
		return {
			ok: false,
			status: "rejected",
			message: "verify and skipVerify cannot be used together",
			progress: input.progress,
			run: input.run,
		};
	}
	const section = input.plan.byId.get(input.id);
	if (!section) {
		return { ok: false, status: "rejected", message: `unknown section id: ${input.id}`, progress: input.progress, run: input.run };
	}
	const effectiveVerify = input.skipVerify ? undefined : input.verify ?? section.verify;

	let status: SectionOperationResult["status"] = "unverified";
	if (effectiveVerify?.trim()) {
		if (!input.runVerify) {
			return { ok: false, status: "rejected", message: "verify command adapter is unavailable", progress: input.progress, run: input.run };
		}
		const verification = await input.runVerify(effectiveVerify);
		if (verification.code !== 0) {
			const blocker = truncate([verification.stderr, verification.stdout].filter(Boolean).join("\n")) || `verify exited with code ${verification.code}`;
			return {
				ok: false,
				status: "verify_failed",
				message: `verification failed for ${input.id}: ${blocker}`,
				progress: input.progress,
				run: input.run,
			};
		}
		status = "verified";
	} else if (!input.skipVerify) {
		return {
			ok: false,
			status: "rejected",
			message: "no verify command is configured; pass skipVerify: true to complete without verification",
			progress: input.progress,
			run: input.run,
		};
	}
	if (input.validateOwnedPaths) {
		const changedOwnedPaths = await input.validateOwnedPaths();
		if (changedOwnedPaths.length > 0) {
			return {
				ok: false,
				status: "commit_failed",
				message: `owned paths changed outside Long Horizon tools: ${changedOwnedPaths.join(", ")}`,
				progress: input.progress,
				run: input.run,
			};
		}
	}

	const boundaryGit = input.refreshGit ? await input.refreshGit() : input.git;
	if (boundaryGit.head !== input.run.baseHead) {
		return {
			ok: false,
			status: "commit_failed",
			message: `Git HEAD changed during this run: expected ${input.run.baseHead ?? "<none>"}, found ${boundaryGit.head ?? "<none>"}`,
			progress: input.progress,
			run: input.run,
		};
	}

	const nextProgress = advanceProgress(input.progress, orderedIds(input.plan), input.note);
	await input.persistProgress(nextProgress);
	const nextSectionId = nextProgress.active;
	let nextRun = completeRunSection(input.run, input.id, nextSectionId);
	const currentGit = input.refreshGit ? await input.refreshGit() : input.git;
	if (currentGit.head !== input.run.baseHead) {
		await input.persistProgress(input.progress);
		return {
			ok: false,
			status: "commit_failed",
			message: `Git HEAD changed during this run: expected ${input.run.baseHead ?? "<none>"}, found ${currentGit.head ?? "<none>"}`,
			progress: input.progress,
			run: input.run,
		};
	}
	const selection = input.selectCommitPaths(currentGit, nextRun, input.pluginTouchedPaths ?? ["progress.md"]);
	if (selection.error) {
		await input.persistProgress(input.progress);
		return {
			ok: false,
			status: "commit_failed",
			message: selection.error,
			progress: input.progress,
			run: input.run,
		};
	}
	try {
		await input.commit(selection.paths, `long-horizon: complete ${input.id}`);
	} catch (error) {
		await input.persistProgress(input.progress);
		return {
			ok: false,
			status: "commit_failed",
			message: error instanceof Error ? error.message : String(error),
			progress: input.progress,
			run: input.run,
			commitPaths: selection.paths,
		};
	}
	if (nextRun.mode === "multi" && !nextRun.completed && input.refreshGit) {
		const committedGit = await input.refreshGit();
		nextRun = {
			...nextRun,
			baseHead: committedGit.head,
			ownedPaths: new Set(),
			unownedPaths: new Set(),
		};
	}
	if (input.run.mode === "single") input.abort();
	const noChangesMessage = selection.paths.length === 0 ? "; no changes to commit" : "";
	const nextActiveMessage = `; next active: ${nextProgress.active ?? "<none>"}`;
	return {
		ok: true,
		status,
		message: `${input.id} completed${status === "unverified" ? " without verification" : ""}${nextActiveMessage}${noChangesMessage}`,
		progress: nextProgress,
		run: nextRun,
		commitPaths: selection.paths,
	};
}

export async function recordAttemptFailure(input: RecordAttemptFailureInput): Promise<RecordAttemptFailureResult> {
	if (input.progress.active !== input.id) {
		return {
			ok: false,
			progress: input.progress,
			message: `section is not the active section: ${input.progress.active ?? "<none>"}`,
		};
	}
	const progress: ProgressState = {
		...input.progress,
		attempts: input.progress.attempts + 1,
		done: [...input.progress.done],
		blocker: [input.blocker],
		tried: [...input.progress.tried, input.tried],
		next: [input.next],
		unknown: [...input.progress.unknown],
	};
	await input.persistProgress(progress);
	return { ok: true, progress, message: `recorded failed attempt for ${input.id}` };
}

export async function reopenSection(input: ReopenSectionInput): Promise<{ ok: boolean; progress: ProgressState; message: string }> {
	if (!input.plan.byId.has(input.id)) {
		return { ok: false, progress: input.progress, message: `unknown section id: ${input.id}` };
	}
	if (!input.progress.done.includes(input.id)) {
		return { ok: false, progress: input.progress, message: `section is not completed: ${input.id}` };
	}
	const progress = reopenProgress(input.progress, input.id, input.reason);
	await input.persistProgress(progress);
	return { ok: true, progress, message: `${input.id} reopened` };
}
