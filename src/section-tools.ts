import { advanceProgress, incrementAttempt, reopenProgress } from "./progress.js";
import { canCompleteSection, completeRunSection } from "./run.js";
import type { GitState, Mode, PlanDocument, ProgressState, RunState } from "./types.js";
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
	note?: string;
	mode: Mode;
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
}

export interface ReopenSectionInput {
	id: string;
	reason?: string;
	plan: PlanDocument;
	progress: ProgressState;
	persistProgress: (state: ProgressState) => Promise<void>;
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

	let status: SectionOperationResult["status"] = "unverified";
	if (input.verify) {
		if (!input.runVerify) {
			return { ok: false, status: "rejected", message: "verify command adapter is unavailable", progress: input.progress, run: input.run };
		}
		const verification = await input.runVerify(input.verify);
		if (verification.code !== 0) {
			const blocker = truncate([verification.stderr, verification.stdout].filter(Boolean).join("\n")) || `verify exited with code ${verification.code}`;
			const failedProgress = incrementAttempt(input.progress, blocker);
			await input.persistProgress(failedProgress);
			return {
				ok: false,
				status: "verify_failed",
				message: `verification failed for ${input.id}`,
				progress: failedProgress,
				run: input.run,
			};
		}
		status = "verified";
	}

	const nextProgress = advanceProgress(input.progress, orderedIds(input.plan), input.note);
	await input.persistProgress(nextProgress);
	const nextSectionId = nextProgress.active;
	const nextRun = completeRunSection(input.run, input.id, nextSectionId);
	const currentGit = input.refreshGit ? await input.refreshGit() : input.git;
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
	if (input.mode === "single") input.abort();
	const noChangesMessage = selection.paths.length === 0 ? "; no changes to commit" : "";
	return {
		ok: true,
		status,
		message: `${input.id} completed${status === "unverified" ? " without verification" : ""}${noChangesMessage}`,
		progress: nextProgress,
		run: nextRun,
		commitPaths: selection.paths,
	};
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
