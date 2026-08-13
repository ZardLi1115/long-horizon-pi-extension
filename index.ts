import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolResultEvent,
} from "@mariozechner/pi-coding-agent";
import { compact, createEditToolDefinition, createWriteToolDefinition } from "@mariozechner/pi-coding-agent";
import { buildDynamicContext, buildStableProtocol } from "./src/context-builder.js";
import { commitPaths, readGitState, selectCommitPaths, type GitAdapter } from "./src/git.js";
import { OwnershipTracker } from "./src/ownership.js";
import {
	createPlanManifest,
	createSnapshotDetails,
	createUpdateDetails,
	diffPlanCache,
	hasPlanCacheDelta,
	parsePlanCacheDocument,
	renderPlanSnapshot,
	renderPlanUpdate,
} from "./src/plan-cache.js";
import { materializeMissingIds, parsePlan } from "./src/plan.js";
import { parseProgress, serializeProgress, withDefaultActive } from "./src/progress.js";
import { completeSection, recordAttemptFailure, reopenSection } from "./src/section-tools.js";
import { runCommand, runShellCommand } from "./src/command.js";
import { startRun, syncRunPaths } from "./src/run.js";
import {
	safeAccessFile,
	safeDeleteFile,
	safeMkdir,
	safeMoveFile,
	safeReadFile,
	safeRelativePath,
	safeWriteFile,
} from "./src/safe-fs.js";
import type {
	ContextSnapshot,
	Mode,
	PlanCacheDocument,
	PlanCacheManifest,
	PlanDocument,
	PlanSnapshotDetails,
	PlanUpdateDetails,
	ProgressState,
	RunState,
} from "./src/types.js";

const MODE_ENTRY = "long-horizon/mode";
const DYNAMIC_CONTEXT_TYPE = "long-horizon/context";
const PLAN_CACHE_TYPE = "long-horizon/plan-cache";
const MAX_STATUS_OUTPUT = 1600;

interface LoadedState {
	plan: PlanDocument;
	progress: ProgressState;
	git: Awaited<ReturnType<typeof readGitState>>;
	hints: string[];
	planPath: string;
	progressPath: string;
}

function textContent(text: string) {
	return [{ type: "text" as const, text }];
}

function truncate(text: string): string {
	return text.length > MAX_STATUS_OUTPUT ? `${text.slice(-MAX_STATUS_OUTPUT)}…` : text;
}

function makeGitAdapter(pi: ExtensionAPI, cwd: string): GitAdapter {
	return {
		async exec(args) {
			const result = await pi.exec("git", args, { cwd });
			return { stdout: result.stdout, stderr: result.stderr, code: result.code };
		},
		async execWithEnv(args, env) {
			const result = await runCommand("git", args, { cwd, env });
			return { stdout: result.stdout, stderr: result.stderr, code: result.code };
		},
	};
}

async function readOptional(cwd: string, relativePath: string): Promise<string> {
	try {
		return (await safeReadFile(cwd, relativePath)).toString("utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

async function loadState(pi: ExtensionAPI, cwd: string): Promise<LoadedState> {
	const planPath = path.join(cwd, "plan.md");
	const progressPath = path.join(cwd, "progress.md");
	const [planSource, progressSource, git] = await Promise.all([
		readOptional(cwd, "plan.md"),
		readOptional(cwd, "progress.md"),
		readGitState(makeGitAdapter(pi, cwd)),
	]);
	const hints: string[] = [];
	let plan: PlanDocument;
	try {
		plan = parsePlan(planSource);
	} catch (error) {
		plan = parsePlan("");
		hints.push(error instanceof Error ? error.message : String(error));
	}
	const progress = parseProgress(progressSource);
	const defaultedProgress = withDefaultActive(progress, plan.sections.map((section) => section.id));
	const effectiveProgress = defaultedProgress;
	if (!progress.active && effectiveProgress.active) hints.push(`progress.md had no active section; defaulted to ${effectiveProgress.active}`);
	if (!planSource.trim()) hints.push("plan.md is missing or has no sections; create plan sections before completing work");
	if (plan.missingIds.length > 0) hints.push(`plan.md has sections without explicit ids: ${plan.missingIds.join(", ")}`);
	if (effectiveProgress.active && !plan.byId.has(effectiveProgress.active)) hints.push(`active section is missing from plan.md: ${effectiveProgress.active}`);
	if (!git.available) hints.push("Git is unavailable; section completion cannot create an automatic commit");
	if (git.conflictPaths.length > 0) hints.push(`Git conflict paths remain: ${git.conflictPaths.join(", ")}`);
	return { plan, progress: effectiveProgress, git, hints, planPath, progressPath };
}

function latestMode(entries: Array<{ type: string; customType?: string; data?: unknown }>): Mode {
	const entry = entries
		.filter((candidate) => candidate.type === "custom" && candidate.customType === MODE_ENTRY)
		.pop();
	const mode = (entry?.data as { mode?: unknown } | undefined)?.mode;
	return mode === "multi" ? "multi" : "single";
}

function statusText(mode: Mode, state: LoadedState, run: RunState | null): string {
	return [
		`mode: ${mode}`,
		`active: ${state.progress.active ?? "<none>"}`,
		`attempts: ${state.progress.attempts}`,
		`head: ${state.git.head ?? "<unavailable>"}`,
		`dirty: ${state.git.dirtyPaths.join(", ") || "<none>"}`,
		`owned: ${run ? [...run.ownedPaths].sort().join(", ") || "<none>" : "<none>"}`,
		`unowned: ${run ? [...run.unownedPaths].sort().join(", ") || "<none>" : "<none>"}`,
		...state.hints.map((hint) => `hint: ${hint}`),
	].join("\n");
}

function hashFile(source: string): string {
	return crypto.createHash("sha256").update(source).digest("hex");
}

function hashContent(source: string | Buffer): string {
	return crypto.createHash("sha256").update(source).digest("hex");
}

async function readOwnedState(cwd: string, relativePath: string): Promise<string | null> {
	try {
		return hashContent(await safeReadFile(cwd, relativePath));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

interface PlanCacheEntryLike {
	type?: string;
	customType?: string;
	details?: unknown;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function hasUniqueStrings(values: string[]): boolean {
	return new Set(values).size === values.length;
}

interface ParsedPlanCacheDetails {
	kind: "snapshot" | "update";
	manifest: PlanCacheManifest;
}

function parsePlanCacheDetails(value: unknown): ParsedPlanCacheDetails | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Partial<PlanCacheManifest> & { kind?: unknown };
	if (candidate.kind !== "snapshot" && candidate.kind !== "update") return null;
	if (candidate.version !== 1 || typeof candidate.generationId !== "string" || !candidate.generationId) return null;
	if (typeof candidate.planHash !== "string" || typeof candidate.structureHash !== "string") return null;
	if (!isStringArray(candidate.order) || !hasUniqueStrings(candidate.order)) return null;
	if (!Array.isArray(candidate.sections)) return null;
	if (candidate.sections.length !== candidate.order.length) return null;
	const sectionIds: string[] = [];
	for (const section of candidate.sections) {
		if (!section || typeof section !== "object") return null;
		const typedSection = section as { id?: unknown; hash?: unknown };
		if (typeof typedSection.id !== "string" || typeof typedSection.hash !== "string") return null;
		sectionIds.push(typedSection.id);
	}
	if (!hasUniqueStrings(sectionIds) || sectionIds.some((id, index) => id !== candidate.order?.[index])) return null;
	if (candidate.kind === "update") {
		const update = candidate as Partial<PlanUpdateDetails>;
		if (!isStringArray(update.changedIds) || !isStringArray(update.deletedIds) || typeof update.structureChanged !== "boolean") return null;
		if (!hasUniqueStrings(update.changedIds) || !hasUniqueStrings(update.deletedIds)) return null;
	}
	return {
		kind: candidate.kind,
		manifest: {
			version: 1,
			generationId: candidate.generationId,
			planHash: candidate.planHash,
			structureHash: candidate.structureHash,
			order: [...candidate.order],
			sections: candidate.sections.map((section) => ({ id: section.id, hash: section.hash })),
		},
	};
}

function restorePlanCacheManifest(entries: PlanCacheEntryLike[]): PlanCacheManifest | null {
	let restored: PlanCacheManifest | null = null;
	for (const entry of entries) {
		if (entry.type !== "custom_message" || entry.customType !== PLAN_CACHE_TYPE) continue;
		const parsed = parsePlanCacheDetails(entry.details);
		if (!parsed) continue;
		if (parsed.kind === "snapshot") {
			restored = parsed.manifest;
			continue;
		}
		if (restored?.generationId === parsed.manifest.generationId) restored = parsed.manifest;
	}
	return restored;
}

function asPlanCacheMessage(
	content: string,
	details: PlanSnapshotDetails | PlanUpdateDetails,
) {
	return {
		customType: PLAN_CACHE_TYPE,
		content,
		display: false,
		details,
	};
}

export default function longHorizonExtension(pi: ExtensionAPI): void {
	let mode: Mode = "single";
	let run: RunState | null = null;
	let ownership: OwnershipTracker | null = null;
	let pluginTouchedPaths = new Set<string>();
	let planCacheManifest: PlanCacheManifest | null = null;
	let pendingInitialSnapshot = false;
	let planCacheQueue: Promise<void> = Promise.resolve();

	const readPlanCache = async (cwd: string): Promise<PlanCacheDocument | null> => {
		try {
			const source = await readOptional(cwd, "plan.md");
			parsePlan(source);
			const materialized = materializeMissingIds(source);
			if (materialized.changed) {
				await safeWriteFile(cwd, "plan.md", materialized.source);
				pluginTouchedPaths.add("plan.md");
			}
			return parsePlanCacheDocument(materialized.source);
		} catch {
			return null;
		}
	};

	const enqueuePlanCache = <T>(operation: () => Promise<T>): Promise<T> => {
		const next = planCacheQueue.then(operation, operation);
		planCacheQueue = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};

	const persistCurrentPlanDelta = (ctx: ExtensionContext, delivery: "steer" | "idle"): Promise<boolean> =>
		enqueuePlanCache(async () => {
			const document = await readPlanCache(ctx.cwd);
			if (!document) return false;
			if (!planCacheManifest) {
				const generationId = crypto.randomUUID();
				const details = createSnapshotDetails(generationId, document);
				await pi.sendMessage(asPlanCacheMessage(renderPlanSnapshot(document), details),
					delivery === "steer" ? { deliverAs: "steer", triggerTurn: false } : { triggerTurn: false });
				planCacheManifest = createPlanManifest(generationId, document);
				pendingInitialSnapshot = false;
				return true;
			}

			const delta = diffPlanCache(planCacheManifest, document);
			if (!hasPlanCacheDelta(delta)) return false;
			const details = createUpdateDetails(planCacheManifest.generationId, delta);
			await pi.sendMessage(asPlanCacheMessage(renderPlanUpdate(delta), details),
				delivery === "steer" ? { deliverAs: "steer", triggerTurn: false } : { triggerTurn: false });
			planCacheManifest = createPlanManifest(planCacheManifest.generationId, document);
			pendingInitialSnapshot = false;
			return true;
		});

	const writeTool = createWriteToolDefinition(process.cwd());
	const safeWriteTool = {
		...writeTool,
		async execute(
			toolCallId: Parameters<typeof writeTool.execute>[0],
			input: Parameters<typeof writeTool.execute>[1],
			signal: Parameters<typeof writeTool.execute>[2],
			onUpdate: Parameters<typeof writeTool.execute>[3],
			ctx: ExtensionContext,
		) {
			const definition = createWriteToolDefinition(ctx.cwd, {
				operations: {
					mkdir: (directory) => safeMkdir(ctx.cwd, directory),
					writeFile: (filePath, content) => safeWriteFile(ctx.cwd, filePath, content),
				},
			});
			return definition.execute(toolCallId, input, signal, onUpdate, ctx);
		},
	};
	const editTool = createEditToolDefinition(process.cwd());
	const safeEditTool = {
		...editTool,
		async execute(
			toolCallId: Parameters<typeof editTool.execute>[0],
			input: Parameters<typeof editTool.execute>[1],
			signal: Parameters<typeof editTool.execute>[2],
			onUpdate: Parameters<typeof editTool.execute>[3],
			ctx: ExtensionContext,
		) {
			const definition = createEditToolDefinition(ctx.cwd, {
				operations: {
					access: (filePath) => safeAccessFile(ctx.cwd, filePath),
					readFile: (filePath) => safeReadFile(ctx.cwd, filePath),
					writeFile: (filePath, content) => safeWriteFile(ctx.cwd, filePath, content),
				},
			});
			return definition.execute(toolCallId, input, signal, onUpdate, ctx);
		},
	};

	const ensureRun = async (ctx: ExtensionContext, forceNewRun = false): Promise<LoadedState> => {
		if (forceNewRun) {
			run = null;
			ownership = new OwnershipTracker(ctx.cwd);
			pluginTouchedPaths = new Set();
		}
		let state = await loadState(pi, ctx.cwd);
		if (state.planPath && state.plan.sections.some((section) => section.generatedId)) {
			const source = await readOptional(ctx.cwd, "plan.md");
			const materialized = materializeMissingIds(source);
			if (materialized.changed) {
				await safeWriteFile(ctx.cwd, "plan.md", materialized.source);
				pluginTouchedPaths.add("plan.md");
				state = await loadState(pi, ctx.cwd);
			}
		}
		if (!state.progress.active) state.hints.push("progress.md has no active section; choose one before editing");
		ownership ??= new OwnershipTracker(ctx.cwd);
		if (forceNewRun && state.progress.active) {
			run = startRun(mode, state.progress, state.git);
		} else if (!run && state.progress.active) {
			run = startRun(mode, state.progress, state.git);
		}
		return state;
	};

	const persistProgress = async (ctx: ExtensionContext, state: ProgressState): Promise<void> => {
		await safeWriteFile(ctx.cwd, "progress.md", serializeProgress(state));
		pluginTouchedPaths.add("progress.md");
	};

	const completeTool = {
		name: "complete_section",
		label: "Complete section",
		description: "Verify and complete the currently locked long-horizon plan section, then commit its owned and runtime-touched changes.",
		promptSnippet: "complete_section(id, verify?, skipVerify?, note?)",
		parameters: Type.Object({
			id: Type.String(),
			verify: Type.Optional(Type.String()),
			skipVerify: Type.Optional(Type.Boolean()),
			note: Type.Optional(Type.String()),
		}),
		executionMode: "sequential" as const,
		async execute(_toolCallId: string, params: { id: string; verify?: string; skipVerify?: boolean; note?: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			const state = await ensureRun(ctx);
			if (!run || !ownership) throw new Error("long-horizon run is not initialized");
			run = syncRunPaths(run, state.git, ownership.owned());
			const runMode = run.mode;
			const result = await completeSection({
				id: params.id,
				verify: params.verify,
				skipVerify: params.skipVerify,
				note: params.note,
				run,
				plan: state.plan,
				progress: state.progress,
				git: state.git,
				runVerify: async (command) => {
					const result = await runShellCommand(command, { cwd: ctx.cwd, timeout: 15 * 60 * 1000, signal: ctx.signal });
					return { code: result.code, stdout: result.stdout, stderr: result.stderr };
				},
				validateOwnedPaths: () => {
					if (!ownership) throw new Error("long-horizon ownership is not initialized");
					return ownership.validate((relativePath) => readOwnedState(ctx.cwd, relativePath));
				},
				persistProgress: (next) => persistProgress(ctx, next),
				refreshGit: async () => readGitState(makeGitAdapter(pi, ctx.cwd)),
				selectCommitPaths: (gitState, runState, touched) => selectCommitPaths(runState, gitState, touched),
				commit: async (paths, message) => {
					const result = await commitPaths(makeGitAdapter(pi, ctx.cwd), paths, message, run?.baseHead);
					if (result.code !== 0) throw new Error(truncate(result.stderr || result.stdout || `git commit exited with ${result.code}`));
				},
				abort: () => setTimeout(() => ctx.abort(), 0),
				pluginTouchedPaths: ["progress.md", ...pluginTouchedPaths],
			});
			run = result.run;
			if (result.ok) {
				pluginTouchedPaths = new Set();
				if (!result.run.completed) ownership = new OwnershipTracker(ctx.cwd);
			}
			return { content: textContent(result.message), details: result, terminate: result.ok && runMode === "single" };
		},
	};

	const recordAttemptFailureTool = {
		name: "record_attempt_failure",
		label: "Record failed attempt",
		description: "Record one concrete approach that failed for the active section. Call only after a real attempt failed or was abandoned.",
		promptSnippet: "record_attempt_failure(id, tried, blocker, next)",
		parameters: Type.Object({
			id: Type.String(),
			tried: Type.String(),
			blocker: Type.String(),
			next: Type.String(),
		}),
		executionMode: "sequential" as const,
		async execute(
			_toolCallId: string,
			params: { id: string; tried: string; blocker: string; next: string },
			_signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			const state = await ensureRun(ctx);
			const result = await recordAttemptFailure({
				id: params.id,
				tried: params.tried,
				blocker: params.blocker,
				next: params.next,
				progress: state.progress,
				persistProgress: (next) => persistProgress(ctx, next),
			});
			const content = result.ok
				? [
						result.message,
						`attempts: ${result.progress.attempts}`,
						`tried: ${result.progress.tried.at(-1) ?? "<none>"}`,
						`blocker: ${result.progress.blocker.at(-1) ?? "<none>"}`,
						`next: ${result.progress.next.at(-1) ?? "<none>"}`,
					].join("\n")
				: result.message;
			return { content: textContent(content), details: result };
		},
	};

	const reopenTool = {
		name: "reopen_section",
		label: "Reopen section",
		description: "Move a completed plan section back to active without rewriting Git history.",
		promptSnippet: "reopen_section(id, reason?)",
		parameters: Type.Object({ id: Type.String(), reason: Type.Optional(Type.String()) }),
		executionMode: "sequential" as const,
		async execute(_toolCallId: string, params: { id: string; reason?: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			const state = await ensureRun(ctx);
			const result = await reopenSection({
				id: params.id,
				reason: params.reason,
				plan: state.plan,
				progress: state.progress,
				persistProgress: (next) => persistProgress(ctx, next),
			});
			if (result.ok) {
				const runMode = run?.mode ?? mode;
				run = startRun(runMode, result.progress, state.git);
				ownership = new OwnershipTracker(ctx.cwd);
			}
			return { content: textContent(result.message), details: result };
		},
	};

	const deleteTool = {
		name: "long_horizon_delete",
		label: "Delete file",
		description: "Delete one file inside the current cwd and register it as owned by this run.",
		promptSnippet: "Delete one file inside the current cwd",
		parameters: Type.Object({ path: Type.String() }),
		 executionMode: "sequential" as const,
		async execute(_toolCallId: string, params: { path: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			const relative = safeRelativePath(ctx.cwd, params.path);
			ownership?.assertCanAcquire(relative, await readOwnedState(ctx.cwd, relative));
			await safeDeleteFile(ctx.cwd, relative);
			ownership?.customSuccess("delete", [relative], new Map([[relative, null]]));
			return { content: textContent(`deleted ${relative}`), details: { path: relative } };
		},
	};

	const moveTool = {
		name: "long_horizon_move",
		label: "Move file",
		description: "Move one file inside the current cwd without overwriting an existing target, and register both paths as owned.",
		promptSnippet: "Move one file inside the current cwd",
		parameters: Type.Object({ from: Type.String(), to: Type.String() }),
		executionMode: "sequential" as const,
		async execute(_toolCallId: string, params: { from: string; to: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			const from = safeRelativePath(ctx.cwd, params.from);
			const to = safeRelativePath(ctx.cwd, params.to);
			ownership?.assertCanAcquire(from, await readOwnedState(ctx.cwd, from));
			ownership?.assertCanAcquire(to, await readOwnedState(ctx.cwd, to));
			await safeMoveFile(ctx.cwd, from, to);
			ownership?.customSuccess(
				"move",
				[from, to],
				new Map([
					[from, null],
					[to, await readOwnedState(ctx.cwd, to)],
				]),
			);
			return { content: textContent(`moved ${from} -> ${to}`), details: { from, to } };
		},
	};

	pi.registerTool(safeWriteTool);
	pi.registerTool(safeEditTool);
	pi.registerTool(completeTool);
	pi.registerTool(recordAttemptFailureTool);
	pi.registerTool(reopenTool);
	pi.registerTool(deleteTool);
	pi.registerTool(moveTool);

	pi.registerCommand("lh", {
		description: "Set long-horizon mode or inspect current state",
		getArgumentCompletions: (prefix) => ["single", "multi", "status"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const command = args.trim() || "status";
			if (command === "single" || command === "multi") {
				mode = command;
				pi.appendEntry(MODE_ENTRY, { mode });
				ctx.ui.notify(`long-horizon mode: ${mode}`, "info");
				return;
			}
			if (command === "status") {
				const state = await loadState(pi, ctx.cwd);
				ctx.ui.notify(statusText(run?.mode ?? mode, state, run), "info");
				return;
			}
			ctx.ui.notify("Usage: /lh single | /lh multi | /lh status", "warning");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		mode = latestMode(ctx.sessionManager.getEntries() as Array<{ type: string; customType?: string; data?: unknown }>);
		run = null;
		ownership = new OwnershipTracker(ctx.cwd);
		pluginTouchedPaths = new Set();
		planCacheManifest = restorePlanCacheManifest(ctx.sessionManager.getEntries() as PlanCacheEntryLike[]);
		pendingInitialSnapshot = planCacheManifest === null;
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		await ensureRun(ctx, true);
		const document = await readPlanCache(ctx.cwd);
		let message;
		if (document && (pendingInitialSnapshot || !planCacheManifest)) {
			const generationId = crypto.randomUUID();
			const details = createSnapshotDetails(generationId, document);
			message = asPlanCacheMessage(renderPlanSnapshot(document), details);
			planCacheManifest = createPlanManifest(generationId, document);
			pendingInitialSnapshot = false;
		} else if (document && planCacheManifest) {
			const delta = diffPlanCache(planCacheManifest, document);
			if (hasPlanCacheDelta(delta)) {
				const details = createUpdateDetails(planCacheManifest.generationId, delta);
				message = asPlanCacheMessage(renderPlanUpdate(delta), details);
				planCacheManifest = createPlanManifest(planCacheManifest.generationId, document);
			}
		}
		return {
			systemPrompt: `${_event.systemPrompt}\n\n${buildStableProtocol()}`,
			...(message ? { message } : {}),
		};
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const state = await ensureRun(ctx);
		if (run && ownership) run = syncRunPaths(run, state.git, ownership.owned());
		const snapshot: ContextSnapshot = {
			mode: run?.mode ?? mode,
			plan: state.plan,
			progress: state.progress,
			git: state.git,
			run,
			hints: state.hints,
			planPath: "plan.md",
			progressPath: "progress.md",
		};
		return {
			message: {
				customType: DYNAMIC_CONTEXT_TYPE,
				content: buildDynamicContext(snapshot),
				display: false,
			},
		};
	});

	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		if (!ownership) return;
		if (event.toolName === "write" || event.toolName === "edit") {
			const input = event.input as { path?: unknown };
			if (typeof input.path === "string") {
				try {
					const relative = safeRelativePath(ctx.cwd, input.path);
					ownership.assertCanAcquire(relative, await readOwnedState(ctx.cwd, relative));
					ownership.pending(event.toolCallId, event.toolName, relative);
				} catch (error) {
					return { block: true, reason: error instanceof Error ? error.message : String(error) };
				}
			}
		}
	});

	pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
		if (!ownership) return;
		if (event.toolName === "write" || event.toolName === "edit") {
			const relativePath = ownership.pendingPath(event.toolCallId);
			const expectedState = !event.isError && relativePath ? await readOwnedState(ctx.cwd, relativePath) : undefined;
			ownership.result(event.toolCallId, event.isError, expectedState);
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		// Coalesce all filesystem changes made during this turn into one final update.
		await persistCurrentPlanDelta(ctx, "steer");
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (run && !run.completed && ownership) {
			const state = await ensureRun(ctx);
			run = syncRunPaths(run, state.git, ownership.owned());
			ctx.ui.notify(
				`long-horizon run incomplete\nactive: ${state.progress.active ?? "<none>"}\nowned: ${[...run.ownedPaths].sort().join(", ") || "<none>"}\nunowned: ${[...run.unownedPaths].sort().join(", ") || "<none>"}\nGit dirty: ${state.git.dirtyPaths.join(", ") || "<none>"}`,
				"warning",
			);
		}
		await persistCurrentPlanDelta(ctx, "idle");
	});

	pi.on("session_compact", async (_event, ctx) => {
		await enqueuePlanCache(async () => {
			try {
				const document = await readPlanCache(ctx.cwd);
				if (!document) throw new Error("plan.md could not be read or parsed after compaction");
				const generationId = crypto.randomUUID();
				const details = createSnapshotDetails(generationId, document);
				await pi.sendMessage(asPlanCacheMessage(renderPlanSnapshot(document), details), { triggerTurn: false });
				planCacheManifest = createPlanManifest(generationId, document);
				pendingInitialSnapshot = false;
			} catch (error) {
				planCacheManifest = null;
				pendingInitialSnapshot = true;
				ctx.ui.notify(
					`Long Horizon plan snapshot after compaction failed; it will be rebuilt before the next model call: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
		});
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const state = await loadState(pi, ctx.cwd);
		const planSource = await readOptional(ctx.cwd, "plan.md");
		const effectiveMode = run?.mode ?? mode;
		if (!ctx.model) {
			ctx.ui.notify("Long Horizon compaction: no active model; using Pi default compaction", "warning");
			return;
		}
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok || !auth.apiKey) {
			ctx.ui.notify("Long Horizon compaction: model auth unavailable; using Pi default compaction", "warning");
			return;
		}
		const memory = [
			"## Execution Position",
			`active: ${state.progress.active ?? "<none>"}`,
			`mode: ${effectiveMode}`,
			"plan_source: plan.md",
			"",
			"## Working Memory",
			`blocker: ${state.progress.blocker.join(" | ") || "<none>"}`,
			`tried: ${state.progress.tried.join(" | ") || "<none>"}`,
			`next: ${state.progress.next.join(" | ") || "<none>"}`,
		].join("\n");
		try {
			const nativeCompaction = await compact(
				event.preparation,
				ctx.model,
				auth.apiKey,
				auth.headers,
				[
					event.customInstructions,
					"Preserve user goals, constraints, key decisions, hypotheses, debugging progress, open questions, and next steps.",
					"Do not copy the full plan.md, progress.md, or Git history because those canonical artifacts are reloaded from disk.",
				].filter(Boolean).join("\n"),
				event.signal,
			);
			return {
				compaction: {
					summary: `${nativeCompaction.summary.trim()}\n\n${memory}`,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
						details: {
							...(typeof nativeCompaction.details === "object" && nativeCompaction.details !== null ? nativeCompaction.details : {}),
							compactedAtHead: state.git.head,
							active: state.progress.active,
							mode: effectiveMode,
							planHash: planSource ? hashFile(planSource) : null,
							planCacheGenerationId: planCacheManifest?.generationId ?? null,
						},
				},
			};
		} catch (error) {
			ctx.ui.notify(`Long Horizon compaction failed; using Pi default: ${error instanceof Error ? error.message : String(error)}`, "warning");
			return;
		}
	});
}
