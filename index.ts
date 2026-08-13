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
import { buildDynamicContext, buildStableProtocol } from "./src/context-builder.js";
import { commitPaths, readGitState, selectCommitPaths, type GitAdapter } from "./src/git.js";
import { OwnershipTracker } from "./src/ownership.js";
import { materializeMissingIds, parsePlan } from "./src/plan.js";
import { parseProgress, serializeProgress, withDefaultActive } from "./src/progress.js";
import { completeSection, reopenSection } from "./src/section-tools.js";
import { prepareProgressForRun, startRun, syncRunPaths } from "./src/run.js";
import type { ContextSnapshot, Mode, PlanDocument, ProgressState, RunState } from "./src/types.js";

const MODE_ENTRY = "long-horizon/mode";
const DYNAMIC_CONTEXT_TYPE = "long-horizon/context";
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

function safeRelative(cwd: string, input: string): string {
	const absolute = path.resolve(cwd, input);
	const relative = path.relative(path.resolve(cwd), absolute);
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`path is outside cwd: ${input}`);
	}
	return relative.split(path.sep).join("/");
}

function assertSafeMutation(cwd: string, input: string): string {
	const relative = safeRelative(cwd, input);
	if (relative === ".git" || relative.startsWith(".git/")) throw new Error("refusing to mutate .git");
	return relative;
}

function makeGitAdapter(pi: ExtensionAPI, cwd: string): GitAdapter {
	return {
		async exec(args) {
			const result = await pi.exec("git", args, { cwd });
			return { stdout: result.stdout, stderr: result.stderr, code: result.code };
		},
	};
}

async function readOptional(filePath: string): Promise<string> {
	try {
		return await fs.readFile(filePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

async function loadState(pi: ExtensionAPI, cwd: string): Promise<LoadedState> {
	const planPath = path.join(cwd, "plan.md");
	const progressPath = path.join(cwd, "progress.md");
	const [planSource, progressSource, git] = await Promise.all([
		readOptional(planPath),
		readOptional(progressPath),
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

export default function longHorizonExtension(pi: ExtensionAPI): void {
	let mode: Mode = "single";
	let run: RunState | null = null;
	let ownership: OwnershipTracker | null = null;
	let pluginTouchedPaths = new Set<string>();

	const ensureRun = async (ctx: ExtensionContext, forceNewRun = false): Promise<LoadedState> => {
		const previousRun = forceNewRun ? run : null;
		if (forceNewRun) {
			run = null;
			ownership = new OwnershipTracker(ctx.cwd);
			pluginTouchedPaths = new Set();
		}
		let state = await loadState(pi, ctx.cwd);
		const initialPreexistingDirtyPaths = [...new Set([...state.git.dirtyPaths, ...state.git.stagedPaths])];
		if (state.planPath && state.plan.sections.some((section) => section.generatedId)) {
			const source = await readOptional(state.planPath);
			const materialized = materializeMissingIds(source);
			if (materialized.changed) {
				await fs.writeFile(state.planPath, materialized.source, "utf8");
				pluginTouchedPaths.add("plan.md");
				state = await loadState(pi, ctx.cwd);
			}
		}
		if (!state.progress.active) state.hints.push("progress.md has no active section; choose one before editing");
		ownership ??= new OwnershipTracker(ctx.cwd);
		if (forceNewRun && state.progress.active) {
			const prepared = prepareProgressForRun(state.progress, previousRun);
			if (prepared.progress.attempts !== state.progress.attempts) {
				await fs.writeFile(state.progressPath, serializeProgress(prepared.progress), "utf8");
				pluginTouchedPaths.add("progress.md");
				state = { ...state, progress: prepared.progress };
			}
			run = startRun(mode, state.progress, state.git, previousRun, initialPreexistingDirtyPaths);
		} else if (!run && state.progress.active) {
			run = startRun(mode, state.progress, state.git, null, initialPreexistingDirtyPaths);
		}
		return state;
	};

	const persistProgress = async (ctx: ExtensionContext, state: ProgressState): Promise<void> => {
		const progressPath = path.join(ctx.cwd, "progress.md");
		await fs.writeFile(progressPath, serializeProgress(state), "utf8");
		pluginTouchedPaths.add("progress.md");
	};

	const completeTool = {
		name: "complete_section",
		label: "Complete section",
		description: "Verify and complete the currently locked long-horizon plan section, then commit its owned changes.",
		promptSnippet: "complete_section(id, verify?, note?)",
		parameters: Type.Object({
			id: Type.String(),
			verify: Type.Optional(Type.String()),
			note: Type.Optional(Type.String()),
		}),
		executionMode: "sequential" as const,
		async execute(_toolCallId: string, params: { id: string; verify?: string; note?: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			const state = await ensureRun(ctx);
			if (!run || !ownership) throw new Error("long-horizon run is not initialized");
			run = syncRunPaths(run, state.git, ownership.owned());
			const result = await completeSection({
				id: params.id,
				verify: params.verify,
				note: params.note,
				mode,
				run,
				plan: state.plan,
				progress: state.progress,
				git: state.git,
				runVerify: async (command) => {
					const result = await pi.exec("sh", ["-lc", command], { cwd: ctx.cwd, timeout: 15 * 60 * 1000, signal: ctx.signal });
					return { code: result.code, stdout: result.stdout, stderr: result.stderr };
				},
				persistProgress: (next) => persistProgress(ctx, next),
				refreshGit: async () => readGitState(makeGitAdapter(pi, ctx.cwd)),
				selectCommitPaths: (gitState, runState, touched) => selectCommitPaths(runState, gitState, touched),
				commit: async (paths, message) => {
					const result = await commitPaths(makeGitAdapter(pi, ctx.cwd), paths, message);
					if (result.code !== 0) throw new Error(truncate(result.stderr || result.stdout || `git commit exited with ${result.code}`));
				},
				abort: () => setTimeout(() => ctx.abort(), 0),
				pluginTouchedPaths: ["progress.md", ...pluginTouchedPaths],
			});
			run = result.run;
			if (result.ok) pluginTouchedPaths = new Set();
			return { content: textContent(result.message), details: result, terminate: result.ok && mode === "single" };
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
			const relative = assertSafeMutation(ctx.cwd, params.path);
			await fs.unlink(path.join(ctx.cwd, relative));
			ownership?.customSuccess("delete", [relative]);
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
			const from = assertSafeMutation(ctx.cwd, params.from);
			const to = assertSafeMutation(ctx.cwd, params.to);
			try {
				await fs.access(path.join(ctx.cwd, to));
				throw new Error(`move target already exists: ${to}`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			await fs.rename(path.join(ctx.cwd, from), path.join(ctx.cwd, to));
			ownership?.customSuccess("move", [from, to]);
			return { content: textContent(`moved ${from} -> ${to}`), details: { from, to } };
		},
	};

	pi.registerTool(completeTool);
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
				const state = await ensureRun(ctx);
				ctx.ui.notify(statusText(mode, state, run), "info");
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
	});

	pi.on("before_agent_start", async (_event, ctx) => {
			await ensureRun(ctx, true);
		return { systemPrompt: `${_event.systemPrompt}\n\n${buildStableProtocol()}` };
	});

	pi.on("context", async (event, ctx) => {
		const state = await ensureRun(ctx);
		if (run && ownership) run = syncRunPaths(run, state.git, ownership.owned());
		const snapshot: ContextSnapshot = {
			mode,
			plan: state.plan,
			progress: state.progress,
			git: state.git,
			run,
			hints: state.hints,
			planPath: "plan.md",
			progressPath: "progress.md",
		};
		const filtered = event.messages.filter((message) => {
			const candidate = message as { customType?: string };
			return candidate.customType !== DYNAMIC_CONTEXT_TYPE;
		});
		return {
			messages: [
				...filtered,
				{
					role: "custom",
					customType: DYNAMIC_CONTEXT_TYPE,
					content: buildDynamicContext(snapshot),
					display: false,
					timestamp: Date.now(),
				},
			],
		};
	});

	pi.on("tool_call", async (event: ToolCallEvent) => {
		if (!ownership) return;
		if (event.toolName === "write" || event.toolName === "edit") {
			const input = event.input as { path?: unknown };
			if (typeof input.path === "string") ownership.pending(event.toolCallId, event.toolName, input.path);
		}
	});

	pi.on("tool_result", async (event: ToolResultEvent) => {
		if (!ownership) return;
		if (event.toolName === "write" || event.toolName === "edit") ownership.result(event.toolCallId, event.isError);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!run || run.completed || !ownership) return;
		const state = await ensureRun(ctx);
		run = syncRunPaths(run, state.git, ownership.owned());
		ctx.ui.notify(
			`long-horizon run incomplete\nactive: ${state.progress.active ?? "<none>"}\nowned: ${[...run.ownedPaths].sort().join(", ") || "<none>"}\nunowned: ${[...run.unownedPaths].sort().join(", ") || "<none>"}\nGit dirty: ${state.git.dirtyPaths.join(", ") || "<none>"}`,
			"warning",
		);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const state = await ensureRun(ctx);
		const planSource = await readOptional(state.planPath);
		const details = {
			compactedAtHead: state.git.head,
			active: state.progress.active,
			mode,
			planHash: planSource ? hashFile(planSource) : null,
		};
		const memory = [
			"## Execution Position",
			`active: ${state.progress.active ?? "<none>"}`,
			`mode: ${mode}`,
			"plan_source: plan.md",
			"",
			"## Working Memory",
			`blocker: ${state.progress.blocker.join(" | ") || "<none>"}`,
			`tried: ${state.progress.tried.join(" | ") || "<none>"}`,
			`next: ${state.progress.next.join(" | ") || "<none>"}`,
		].join("\n");
		return {
			compaction: {
				summary: memory,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details,
			},
		};
	});
}
