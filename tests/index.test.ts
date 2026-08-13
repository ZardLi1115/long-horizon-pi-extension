import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import longHorizonExtension from "../index.js";
import { createSnapshotDetails, parsePlanCacheDocument } from "../src/plan-cache.js";

const commandMocks = vi.hoisted(() => ({
	runCommand: vi.fn(async (_executable: string, args: string[]) => {
		if (args[0] === "write-tree") return { stdout: "tree-new\n", stderr: "", code: 0, killed: false };
		if (args[0] === "commit-tree") return { stdout: "def\n", stderr: "", code: 0, killed: false };
		return { stdout: "", stderr: "", code: 0, killed: false };
	}),
	runShellCommand: vi.fn(async () => ({ stdout: "", stderr: "", code: 0, killed: false })),
}));

vi.mock("../src/command.js", () => commandMocks);

beforeEach(() => {
	vi.clearAllMocks();
});

async function createPlanCacheFixture(planSource: string, entries: unknown[] = []) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "long-horizon-plan-cache-"));
	await fs.writeFile(path.join(cwd, "plan.md"), planSource);
	await fs.writeFile(path.join(cwd, "progress.md"), "active: one\nattempts: 0\n");
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const tools = new Map<string, any>();
	const sent: Array<{ message: any; options: any }> = [];
	const pi = {
		on(event: string, handler: (event: any, ctx: any) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		appendEntry() {},
		sendMessage(message: any, options: any) {
			sent.push({ message, options });
		},
		async exec(command: string, args: string[]) {
			if (command === "git" && args[0] === "rev-parse") return { stdout: "abc\n", stderr: "", code: 0, killed: false };
			if (command === "git" && args[0] === "status") return { stdout: "", stderr: "", code: 0, killed: false };
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
	} as unknown as ExtensionAPI;
	longHorizonExtension(pi);
	const ctx = {
		cwd,
		hasUI: false,
		ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
		sessionManager: { getEntries: () => entries },
		signal: undefined,
		abort: vi.fn(),
	} as unknown as ExtensionContext;
	await handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
	return { cwd, handlers, sent, tools, ctx, pi };
}

async function runBeforeAgentStart(fixture: Awaited<ReturnType<typeof createPlanCacheFixture>>, prompt = "query") {
	const results: any[] = [];
	for (const handler of fixture.handlers.get("before_agent_start") ?? []) {
		const result = await handler({ prompt, systemPrompt: "base" }, fixture.ctx);
		if (result) results.push(result);
	}
	return results;
}

describe("Pi extension wiring", () => {
	it("creates one immutable query snapshot and preserves the append-only transcript", async () => {
		const fixture = await createPlanCacheFixture("### One\n<!-- id: one -->\n");
		expect(fixture.handlers.get("context")).toBeUndefined();

		const beforeResults = await runBeforeAgentStart(fixture, "first query");
		const dynamicResult = beforeResults.find((result) => result.message?.customType === "long-horizon/context");
		expect(dynamicResult?.message?.content).toContain("attempts: 0");

		const firstCallMessages = [
			{ role: "user", content: [{ type: "text", text: "first query" }] },
			...beforeResults.map((result) => ({ role: "custom", ...result.message })),
		];
		const secondCallInput = [
			...firstCallMessages,
			{ role: "assistant", content: [{ type: "text", text: "reading" }] },
			{ role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "ok" }] },
		];

		expect(secondCallInput.slice(0, firstCallMessages.length)).toEqual(firstCallMessages);
		expect(secondCallInput.filter((message: any) => message.customType === "long-horizon/context")).toHaveLength(1);
	});

	it("does not refresh the query snapshot after tool state changes", async () => {
		const fixture = await createPlanCacheFixture("### One\n<!-- id: one -->\n");

		const beforeResults = await runBeforeAgentStart(fixture, "first query");
		const dynamic = beforeResults.find((result) => result.message?.customType === "long-horizon/context");
		const snapshotContent = dynamic.message.content;
		await fixture.tools.get("record_attempt_failure").execute(
			"attempt-1",
			{ id: "one", tried: "focused test", blocker: "assertion failed", next: "inspect fixture" },
			undefined,
			undefined,
			fixture.ctx,
		);

		const messages = beforeResults.map((result) => ({ role: "custom", ...result.message }));

		expect(messages.find((message) => message.customType === "long-horizon/context")?.content).toBe(
			snapshotContent,
		);
		expect(snapshotContent).toContain("attempts: 0");
	});

	it("creates a fresh dynamic snapshot for the next user query", async () => {
		const fixture = await createPlanCacheFixture("### One\n<!-- id: one -->\n");

		const firstResults = await runBeforeAgentStart(fixture, "first query");
		await fixture.tools.get("record_attempt_failure").execute(
			"attempt-1",
			{ id: "one", tried: "focused test", blocker: "assertion failed", next: "inspect fixture" },
			undefined,
			undefined,
			fixture.ctx,
		);
		const secondResults = await runBeforeAgentStart(fixture, "second query");

		const firstSnapshot = firstResults.find((result) => result.message?.customType === "long-horizon/context")?.message?.content;
		const secondSnapshot = secondResults.find((result) => result.message?.customType === "long-horizon/context")?.message?.content;
		expect(firstSnapshot).toContain("attempts: 0");
		expect(secondSnapshot).toContain("attempts: 1");
		expect(secondSnapshot).not.toBe(firstSnapshot);
	});

	it("does not increase attempts when agent turns start", async () => {
		const fixture = await createPlanCacheFixture("### One\n<!-- id: one -->\n");

		await fixture.handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, fixture.ctx);
		await fixture.handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, fixture.ctx);

		expect(await fs.readFile(path.join(fixture.cwd, "progress.md"), "utf8")).toContain("attempts: 0");
	});

	it("registers record_attempt_failure and persists only model-declared failures", async () => {
		const fixture = await createPlanCacheFixture("### One\n<!-- id: one -->\n");

		await fixture.handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, fixture.ctx);
		const result = await fixture.tools.get("record_attempt_failure").execute(
			"attempt-1",
			{
				id: "one",
				tried: "focused test",
				blocker: "assertion still fails",
				next: "inspect fixture",
			},
			undefined,
			undefined,
			fixture.ctx,
		);

		expect(result.details.ok).toBe(true);
		expect(result.details.progress.attempts).toBe(1);
		expect(result.content[0].text).toContain("attempts: 1");
		expect(result.content[0].text).toContain("blocker: assertion still fails");
		expect(result.content[0].text).toContain("next: inspect fixture");
		expect(await fs.readFile(path.join(fixture.cwd, "progress.md"), "utf8")).toContain("attempts: 1");
	});

	it("commits progress after an earlier query left progress.md dirty", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "long-horizon-progress-boundary-"));
		await fs.writeFile(path.join(cwd, "plan.md"), "### One\n<!-- id: one -->\n");
		await fs.writeFile(path.join(cwd, "progress.md"), "active: one\nattempts: 0\n");
		const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
		const tools = new Map<string, any>();
		let statusCalls = 0;
		const pi = {
			on(event: string, handler: (event: any, ctx: any) => unknown) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
			registerCommand() {},
			appendEntry() {},
			async exec(command: string, args: string[]) {
				if (command !== "git") return { stdout: "", stderr: "", code: 0, killed: false };
				if (args[0] === "rev-parse" && args[1]?.endsWith("^{tree}")) return { stdout: "tree-base\n", stderr: "", code: 0, killed: false };
				if (args[0] === "rev-parse") return { stdout: "abc\n", stderr: "", code: 0, killed: false };
				if (args[0] === "status") {
					statusCalls += 1;
					return {
						stdout: statusCalls < 2 ? "" : " M progress.md\0",
						stderr: "",
						code: 0,
						killed: false,
					};
				}
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		} as unknown as ExtensionAPI;
		longHorizonExtension(pi);
		const ctx = {
			cwd,
			hasUI: false,
			ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
			sessionManager: { getEntries: () => [] },
			signal: undefined,
			abort: vi.fn(),
		} as unknown as ExtensionContext;

		await handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
		await handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, ctx);
		await handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, ctx);
		const result = await tools.get("complete_section").execute(
			"complete-1",
			{ id: "one", skipVerify: true },
			undefined,
			undefined,
			ctx,
		);

		expect(result.details.ok).toBe(true);
		expect(result.details.status).toBe("unverified");
	});

	it("returns a hidden full plan snapshot before the first model call", async () => {
		const fixture = await createPlanCacheFixture("### One\n<!-- id: one -->\nbody\n");

		const result = (await fixture.handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, fixture.ctx)) as any;

		expect(result).toMatchObject({
			systemPrompt: expect.stringContaining("[Long-Horizon Protocol]"),
			message: {
				customType: "long-horizon/plan-cache",
				display: false,
				content: expect.stringContaining("[Plan Cached Snapshot]"),
				details: expect.objectContaining({ version: 1, kind: "snapshot", generationId: expect.any(String), order: ["one"] }),
			},
		});
	});

	it("restores a cached manifest and emits only the current query-gap update", async () => {
		const oldDocument = parsePlanCacheDocument("### One\n<!-- id: one -->\nold body\n");
		const details = createSnapshotDetails("generation-1", oldDocument);
		const entries = [
			{
				type: "custom_message",
				customType: "long-horizon/plan-cache",
				content: "[Plan Cached Snapshot]",
				display: false,
				details,
			},
		];
		const fixture = await createPlanCacheFixture("### One\n<!-- id: one -->\nnew body\n", entries);

		const result = (await fixture.handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, fixture.ctx)) as any;

		expect(result.message.content).toContain("[Plan Updates Since Cached Snapshot]");
		expect(result.message.content).toContain("new body");
		expect(result.message.content).not.toContain("old body");
		expect(result.message.details).toMatchObject({ generationId: "generation-1", kind: "update", changedIds: ["one"] });

		const nextResult = (await fixture.handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, fixture.ctx)) as any;
		expect(nextResult.message).toBeUndefined();
	});

	it("coalesces final plan changes at turn_end and does not repeat them at agent_end", async () => {
		const fixture = await createPlanCacheFixture("### One\n<!-- id: one -->\nold body\n");
		await fixture.handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, fixture.ctx);
		await fs.writeFile(path.join(fixture.cwd, "plan.md"), "### One\n<!-- id: one -->\nfinal body\n");

		await fixture.handlers.get("turn_end")?.[0]?.({ type: "turn_end" }, fixture.ctx);
		await fixture.handlers.get("agent_end")?.[0]?.({ messages: [] }, fixture.ctx);

		expect(fixture.sent).toHaveLength(1);
		expect(fixture.sent[0]).toMatchObject({
			message: {
				customType: "long-horizon/plan-cache",
				display: false,
				content: expect.stringContaining("final body"),
			},
			options: { deliverAs: "steer", triggerTurn: false },
		});
		expect(fixture.sent[0].message.content).not.toContain("old body");
	});

	it("starts a new cache generation only after successful compaction", async () => {
		const fixture = await createPlanCacheFixture("### One\n<!-- id: one -->\nold body\n");
		const initial = (await fixture.handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, fixture.ctx)) as any;
		const initialGeneration = initial.message.details.generationId;
		await fs.writeFile(path.join(fixture.cwd, "plan.md"), "### One\n<!-- id: one -->\nnew body\n");

		await fixture.handlers.get("session_compact")?.[0]?.(
			{ compactionEntry: { id: "compact-1", details: {} }, fromExtension: true },
			fixture.ctx,
		);

		expect(fixture.sent).toHaveLength(1);
		expect(fixture.sent[0]).toMatchObject({
			message: {
				customType: "long-horizon/plan-cache",
				content: expect.stringContaining("[Plan Cached Snapshot]"),
				display: false,
				details: { kind: "snapshot", generationId: expect.any(String) },
			},
			options: { triggerTurn: false },
		});
		expect(fixture.sent[0].message.details.generationId).not.toBe(initialGeneration);
	});

	it("does not let malformed plan content abort before_agent_start", async () => {
		const fixture = await createPlanCacheFixture("### One\n<!-- id: same -->\n<<<<<<< HEAD\nold\n=======\nnew\n>>>>>>> branch\n");

		const result = (await fixture.handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, fixture.ctx)) as any;

		expect(result.systemPrompt).toContain("[Long-Horizon Protocol]");
		expect(result.message).toBeUndefined();
	});

	it("emits a tombstone and structure update for deleted and rearranged sections", async () => {
		const fixture = await createPlanCacheFixture(
			"# Plan\n\n## Chapter\n\n### One\n<!-- id: one -->\none body\n\n### Removed\n<!-- id: removed -->\ngone\n",
		);
		await fixture.handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, fixture.ctx);
		await fs.writeFile(
			path.join(fixture.cwd, "plan.md"),
			"# Plan\n\n## Renamed Chapter\n\n### New\n<!-- id: new -->\nnew body\n\n### One\n<!-- id: one -->\none body\n",
		);

		await fixture.handlers.get("turn_end")?.[0]?.({ type: "turn_end" }, fixture.ctx);

		expect(fixture.sent).toHaveLength(1);
		expect(fixture.sent[0].message.content).toContain("## removed\n\n<!-- deleted: true -->");
		expect(fixture.sent[0].message.content).toContain("## __plan-structure__");
		expect(fixture.sent[0].message.content).toContain("<!-- section: new -->\n<!-- section: one -->");
	});

	it("ignores invalid and generation-disconnected cache entries when resuming", async () => {
		const validDocument = parsePlanCacheDocument("### One\n<!-- id: one -->\nbody\n");
		const validSnapshot = createSnapshotDetails("generation-1", validDocument);
		const disconnectedUpdate = {
			...validSnapshot,
			kind: "update" as const,
			generationId: "generation-2",
			changedIds: ["one"],
			deletedIds: [],
			structureChanged: false,
		};
		const fixture = await createPlanCacheFixture("### One\n<!-- id: one -->\nbody\n", [
			{ type: "custom_message", customType: "long-horizon/plan-cache", details: { version: 2 } },
			{ type: "custom_message", customType: "long-horizon/plan-cache", details: disconnectedUpdate },
			{ type: "custom_message", customType: "long-horizon/plan-cache", details: validSnapshot },
		]);

		const result = (await fixture.handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, fixture.ctx)) as any;

		expect(result.message).toBeUndefined();
	});

	it("keeps the previous generation when compaction does not complete", async () => {
		const fixture = await createPlanCacheFixture("### One\n<!-- id: one -->\nold body\n");
		const initial = (await fixture.handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, fixture.ctx)) as any;
		const generationId = initial.message.details.generationId;
		await fixture.handlers.get("session_before_compact")?.[0]?.({
			type: "session_before_compact",
			preparation: {},
			branchEntries: [],
			signal: new AbortController().signal,
		}, fixture.ctx);
		await fs.writeFile(path.join(fixture.cwd, "plan.md"), "### One\n<!-- id: one -->\nchanged body\n");

		await fixture.handlers.get("turn_end")?.[0]?.({ type: "turn_end" }, fixture.ctx);

		expect(fixture.sent).toHaveLength(1);
		expect(fixture.sent[0].message.details).toMatchObject({ kind: "update", generationId });
	});

	it("materializes missing section ids before appending a turn-end plan update", async () => {
		const fixture = await createPlanCacheFixture("### One\n<!-- id: one -->\nold body\n");
		await fixture.handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, fixture.ctx);
		await fs.writeFile(path.join(fixture.cwd, "plan.md"), "### One\nnew body\n");

		await fixture.handlers.get("turn_end")?.[0]?.({ type: "turn_end" }, fixture.ctx);

		expect(await fs.readFile(path.join(fixture.cwd, "plan.md"), "utf8")).toContain("<!-- id: one -->");
		expect(fixture.sent).toHaveLength(1);
		expect(fixture.sent[0].message.content).toContain("<!-- id: one -->");
	});

	it("rebuilds a full snapshot after compaction snapshot persistence fails", async () => {
		const fixture = await createPlanCacheFixture("### One\n<!-- id: one -->\nbody\n");
		const initial = (await fixture.handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, fixture.ctx)) as any;
		const originalSendMessage = (fixture.pi as any).sendMessage;
		(fixture.pi as any).sendMessage = () => {
			throw new Error("session write failed");
		};

		await fixture.handlers.get("session_compact")?.[0]?.(
			{ compactionEntry: { id: "compact-1", details: {} }, fromExtension: true },
			fixture.ctx,
		);

		(fixture.pi as any).sendMessage = originalSendMessage;
		const next = (await fixture.handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, fixture.ctx)) as any;

		expect(initial.message.details.kind).toBe("snapshot");
		expect(next.message).toMatchObject({
			customType: "long-horizon/plan-cache",
			content: expect.stringContaining("[Plan Cached Snapshot]"),
			details: { kind: "snapshot", version: 1 },
		});
	});

	it("rejects automatic plan id materialization through a symlink", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "long-horizon-plan-materialize-symlink-"));
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "long-horizon-plan-materialize-outside-"));
		const outsidePlan = path.join(outside, "plan.md");
		await fs.writeFile(outsidePlan, "### One\nbody\n");
		await fs.writeFile(path.join(cwd, "progress.md"), "active: one\nattempts: 0\n");
		await fs.symlink(outsidePlan, path.join(cwd, "plan.md"));
		const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
		const pi = {
			on(event: string, handler: (event: any, ctx: any) => unknown) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool() {},
			registerCommand() {},
			appendEntry() {},
			async exec(command: string, args: string[]) {
				if (command === "git" && args[0] === "rev-parse") return { stdout: "abc\n", stderr: "", code: 0, killed: false };
				if (command === "git" && args[0] === "status") return { stdout: "", stderr: "", code: 0, killed: false };
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		} as unknown as ExtensionAPI;
		longHorizonExtension(pi);
		const ctx = {
			cwd,
			hasUI: false,
			ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
			sessionManager: { getEntries: () => [] },
			signal: undefined,
			abort: vi.fn(),
		} as unknown as ExtensionContext;
		await handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);

		await expect(handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, ctx)).rejects.toThrow(/symlink|symbolic link|safe filesystem/);
		await expect(fs.readFile(outsidePlan, "utf8")).resolves.toBe("### One\nbody\n");
	});

	it("rejects automatic progress persistence through a symlink", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "long-horizon-progress-symlink-"));
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "long-horizon-progress-outside-"));
		const outsideProgress = path.join(outside, "progress.md");
		await fs.writeFile(path.join(cwd, "plan.md"), "### One\n<!-- id: one -->\nbody\n");
		await fs.writeFile(outsideProgress, "active: one\nattempts: 0\n");
		await fs.symlink(outsideProgress, path.join(cwd, "progress.md"));
		const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
		const pi = {
			on(event: string, handler: (event: any, ctx: any) => unknown) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool() {},
			registerCommand() {},
			appendEntry() {},
			async exec(command: string, args: string[]) {
				if (command === "git" && args[0] === "rev-parse") return { stdout: "abc\n", stderr: "", code: 0, killed: false };
				if (command === "git" && args[0] === "status") return { stdout: "", stderr: "", code: 0, killed: false };
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		} as unknown as ExtensionAPI;
		longHorizonExtension(pi);
		const ctx = {
			cwd,
			hasUI: false,
			ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
			sessionManager: { getEntries: () => [] },
			signal: undefined,
			abort: vi.fn(),
		} as unknown as ExtensionContext;
		await handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);

		await expect(handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, ctx)).rejects.toThrow(/symlink|symbolic link|safe filesystem/);
		await expect(fs.readFile(outsideProgress, "utf8")).resolves.toBe("active: one\nattempts: 0\n");
	});

	it("requires an explicit skip to bypass plan metadata verification", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "long-horizon-pi-"));
		await fs.writeFile(
			path.join(cwd, "plan.md"),
			["### One", "<!-- id: one -->", "<!-- verify: this must not run -->", "### Two", "<!-- id: two -->", ""].join("\n"),
		);
		await fs.writeFile(path.join(cwd, "progress.md"), "active: one\nattempts: 0\n");
		await fs.mkdir(path.join(cwd, "src"));
		await fs.writeFile(path.join(cwd, "src/file.ts"), "export const value = 1;\n");

		const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
		const tools = new Map<string, any>();
		const execCalls: string[][] = [];
		let statusCalls = 0;
		let aborted = 0;
		const notify = vi.fn();
		const pi = {
			on(event: string, handler: (event: any, ctx: any) => unknown) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
			registerCommand() {},
			appendEntry() {},
			async exec(command: string, args: string[]) {
				execCalls.push([command, ...args]);
				if (command === "sh" || command === "env") throw new Error(`${command} must not be used by the extension`);
				if (command !== "git") return { stdout: "", stderr: "", code: 0, killed: false };
				if (args[0] === "rev-parse" && args[1]?.endsWith("^{tree}")) {
					return { stdout: "tree-base\n", stderr: "", code: 0, killed: false };
				}
				if (args[0] === "rev-parse") return { stdout: "abc\n", stderr: "", code: 0, killed: false };
				if (args[0] === "status") {
					statusCalls += 1;
					return {
						stdout: statusCalls < 2 ? "" : " M src/file.ts\n M progress.md\n",
						stderr: "",
						code: 0,
						killed: false,
					};
				}
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		} as unknown as ExtensionAPI;
		longHorizonExtension(pi);

		const ctx = {
			cwd,
			hasUI: false,
			ui: { notify, setStatus: vi.fn(), setWidget: vi.fn() },
			sessionManager: { getEntries: () => [] },
			signal: undefined,
			abort: () => {
				aborted += 1;
			},
		} as unknown as ExtensionContext;
		await handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
		await handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, ctx);
		await handlers.get("tool_call")?.[0]?.({ toolName: "write", toolCallId: "write-1", input: { path: "src/file.ts" } }, ctx);
		await handlers.get("tool_result")?.[0]?.({ toolName: "write", toolCallId: "write-1", isError: false }, ctx);

		expect(tools.get("long_horizon_delete").promptSnippet).toBe("Delete one file inside the current cwd");
		expect(tools.get("long_horizon_move").promptSnippet).toBe("Move one file inside the current cwd");

		const result = await tools.get("complete_section").execute("complete-1", { id: "one", skipVerify: true }, undefined, undefined, ctx);

		expect(result.details.status).toBe("unverified");
		expect(execCalls.some(([command]) => command === "sh" || command === "env")).toBe(false);
		expect(commandMocks.runShellCommand).not.toHaveBeenCalled();
		expect(commandMocks.runCommand.mock.calls.every(([executable]) => executable === "git")).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(aborted).toBe(1);
	});

	it("executes section.verify through the command adapter by default", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "long-horizon-index-verify-default-"));
		await fs.writeFile(path.join(cwd, "plan.md"), "### One\n<!-- id: one -->\n<!-- verify: printf verify-default -->\n");
		await fs.writeFile(path.join(cwd, "progress.md"), "active: one\nattempts: 0\n");
		const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
		const tools = new Map<string, any>();
		const pi = {
			on(event: string, handler: (event: any, ctx: any) => unknown) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
			registerCommand() {},
			appendEntry() {},
			async exec(command: string, args: string[]) {
				if (command === "git" && args[0] === "rev-parse") return { stdout: "abc\n", stderr: "", code: 0, killed: false };
				if (command === "git" && args[0] === "status") return { stdout: "", stderr: "", code: 0, killed: false };
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		} as unknown as ExtensionAPI;
		longHorizonExtension(pi);
		const ctx = {
			cwd,
			hasUI: false,
			ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
			sessionManager: { getEntries: () => [] },
			signal: undefined,
			abort: vi.fn(),
		} as unknown as ExtensionContext;

		await handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
		await handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, ctx);
		const result = await tools.get("complete_section").execute("complete-1", { id: "one" }, undefined, undefined, ctx);

		expect(result.details.status).toBe("verified");
		expect(commandMocks.runShellCommand).toHaveBeenCalledWith(
			"printf verify-default",
			expect.objectContaining({ cwd, timeout: 15 * 60 * 1000 }),
		);
	});

	it("rejects completion when an owned file changes after the tool result", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "long-horizon-index-owned-change-"));
		await fs.writeFile(path.join(cwd, "plan.md"), "### One\n<!-- id: one -->\n");
		await fs.writeFile(path.join(cwd, "progress.md"), "active: one\nattempts: 0\n");
		await fs.mkdir(path.join(cwd, "src"));
		await fs.writeFile(path.join(cwd, "src/file.ts"), "agent version\n");
		const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
		const tools = new Map<string, any>();
		const pi = {
			on(event: string, handler: (event: any, ctx: any) => unknown) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
			registerCommand() {},
			appendEntry() {},
			async exec(command: string, args: string[]) {
				if (command === "git" && args[0] === "rev-parse") return { stdout: "abc\n", stderr: "", code: 0, killed: false };
				if (command === "git" && args[0] === "status") return { stdout: "", stderr: "", code: 0, killed: false };
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		} as unknown as ExtensionAPI;
		longHorizonExtension(pi);
		const ctx = {
			cwd,
			hasUI: false,
			ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
			sessionManager: { getEntries: () => [] },
			signal: undefined,
			abort: vi.fn(),
		} as unknown as ExtensionContext;

		await handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
		await handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, ctx);
		await handlers.get("tool_call")?.[0]?.({ toolName: "write", toolCallId: "write-1", input: { path: "src/file.ts" } }, ctx);
		await handlers.get("tool_result")?.[0]?.({ toolName: "write", toolCallId: "write-1", isError: false }, ctx);
		await fs.writeFile(path.join(cwd, "src/file.ts"), "external version\n");

		const blocked = await handlers.get("tool_call")?.[0]?.(
			{ toolName: "write", toolCallId: "write-2", input: { path: "src/file.ts" } },
			ctx,
		);
		expect(blocked).toMatchObject({ block: true, reason: expect.stringContaining("owned path changed outside") });

		const result = await tools.get("complete_section").execute("complete-1", { id: "one", skipVerify: true }, undefined, undefined, ctx);

		expect(result.details.status).toBe("commit_failed");
		expect(result.details.message).toContain("src/file.ts");
	});

	it("rejects completion when verification changes an owned file", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "long-horizon-index-verify-change-"));
		await fs.writeFile(path.join(cwd, "plan.md"), "### One\n<!-- id: one -->\n<!-- verify: mutate-owned -->\n");
		await fs.writeFile(path.join(cwd, "progress.md"), "active: one\nattempts: 0\n");
		await fs.mkdir(path.join(cwd, "src"));
		await fs.writeFile(path.join(cwd, "src/file.ts"), "agent version\n");
		const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
		const tools = new Map<string, any>();
		const pi = {
			on(event: string, handler: (event: any, ctx: any) => unknown) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
			registerCommand() {},
			appendEntry() {},
			async exec(command: string, args: string[]) {
				if (command === "git" && args[0] === "rev-parse") return { stdout: "abc\n", stderr: "", code: 0, killed: false };
				if (command === "git" && args[0] === "status") return { stdout: "", stderr: "", code: 0, killed: false };
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		} as unknown as ExtensionAPI;
		longHorizonExtension(pi);
		const ctx = {
			cwd,
			hasUI: false,
			ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
			sessionManager: { getEntries: () => [] },
			signal: undefined,
			abort: vi.fn(),
		} as unknown as ExtensionContext;

		await handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
		await handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, ctx);
		await handlers.get("tool_call")?.[0]?.({ toolName: "write", toolCallId: "write-1", input: { path: "src/file.ts" } }, ctx);
		await handlers.get("tool_result")?.[0]?.({ toolName: "write", toolCallId: "write-1", isError: false }, ctx);
		(commandMocks.runShellCommand as any).mockImplementationOnce(async () => {
			await fs.writeFile(path.join(cwd, "src/file.ts"), "verify version\n");
			return { stdout: "", stderr: "", code: 0, killed: false };
		});

		const result = await tools.get("complete_section").execute("complete-1", { id: "one" }, undefined, undefined, ctx);

		expect(result.details.status).toBe("commit_failed");
		expect(result.details.message).toContain("src/file.ts");
	});

	it("defers single-mode abort until after the tool result is returned", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "long-horizon-abort-"));
		await fs.writeFile(path.join(cwd, "plan.md"), "### One\n<!-- id: one -->\n");
		await fs.writeFile(path.join(cwd, "progress.md"), "active: one\nattempts: 0\n");
		const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
		const tools = new Map<string, any>();
		const order: string[] = [];
		const pi = {
			on(event: string, handler: (event: any, ctx: any) => unknown) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
			registerCommand() {},
			appendEntry() {},
			async exec(command: string, args: string[]) {
				if (command === "git" && args[0] === "rev-parse") return { stdout: "abc\n", stderr: "", code: 0, killed: false };
				if (command === "git" && args[0] === "status") return { stdout: "", stderr: "", code: 0, killed: false };
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		} as unknown as ExtensionAPI;
		longHorizonExtension(pi);
		const ctx = {
			cwd,
			hasUI: false,
			ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
			sessionManager: { getEntries: () => [] },
			signal: undefined,
			abort: () => {
				order.push("abort");
			},
		} as unknown as ExtensionContext;
		await handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
		await handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, ctx);
		const result = await tools.get("complete_section").execute("complete-1", { id: "one", skipVerify: true }, undefined, undefined, ctx);
		order.push("returned");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(result.terminate).toBe(true);
		expect(order).toEqual(["returned", "abort"]);
	});

	it("materializes missing plan ids during state load and keeps bootstrap context available", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "long-horizon-bootstrap-"));
		await fs.writeFile(path.join(cwd, "plan.md"), "### First Section\nbody\n");
		await fs.writeFile(path.join(cwd, "progress.md"), "active: missing\nattempts: 0\n");
		const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
		const pi = {
			on(event: string, handler: (event: any, ctx: any) => unknown) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool() {},
			registerCommand() {},
			appendEntry() {},
			async exec(command: string, args: string[]) {
				if (command === "git" && args[0] === "rev-parse") return { stdout: "abc\n", stderr: "", code: 0, killed: false };
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		} as unknown as ExtensionAPI;
		longHorizonExtension(pi);
		const ctx = {
			cwd,
			hasUI: false,
			ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
			sessionManager: { getEntries: () => [] },
			signal: undefined,
			abort: vi.fn(),
		} as unknown as ExtensionContext;
		await handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
		await handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, ctx);
		const beforeResult = await handlers.get("before_agent_start")?.[1]?.({ systemPrompt: "base" }, ctx);

		expect(await fs.readFile(path.join(cwd, "plan.md"), "utf8")).toContain("<!-- id: first-section -->");
		expect((beforeResult as { message: { content: string } }).message.content).toContain(
			"active section is missing from plan.md: missing",
		);
	});

	it("starts a fresh ownership scope for each user query", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "long-horizon-run-scope-"));
		await fs.writeFile(path.join(cwd, "plan.md"), "### One\n<!-- id: one -->\n");
		await fs.writeFile(path.join(cwd, "progress.md"), "active: one\nattempts: 0\n");
		const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
		const execCalls: string[][] = [];
		const pi = {
			on(event: string, handler: (event: any, ctx: any) => unknown) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool() {},
			registerCommand() {},
			appendEntry() {},
			async exec(command: string, args: string[]) {
				execCalls.push([command, ...args]);
				if (command === "git" && args[0] === "rev-parse") return { stdout: "abc\n", stderr: "", code: 0, killed: false };
				if (command === "git" && args[0] === "status") return { stdout: "", stderr: "", code: 0, killed: false };
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		} as unknown as ExtensionAPI;
		longHorizonExtension(pi);
		const ctx = {
			cwd,
			hasUI: false,
			ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
			sessionManager: { getEntries: () => [] },
			signal: undefined,
			abort: vi.fn(),
		} as unknown as ExtensionContext;
		await handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
		await handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, ctx);
		await handlers.get("tool_call")?.[0]?.({ toolName: "write", toolCallId: "write-1", input: { path: "old.ts" } }, ctx);
		await handlers.get("tool_result")?.[0]?.({ toolName: "write", toolCallId: "write-1", isError: false }, ctx);
		await handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, ctx);
		await handlers.get("agent_end")?.[0]?.({ messages: [] }, ctx);

		expect(execCalls.some((call) => call.includes("old.ts"))).toBe(false);
	});

	it("refreshes unowned dirty paths for context and incomplete-run reporting", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "long-horizon-unowned-"));
		await fs.writeFile(path.join(cwd, "plan.md"), "### One\n<!-- id: one -->\n");
		await fs.writeFile(path.join(cwd, "progress.md"), "active: one\nattempts: 0\n");
		const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
		let statusCalls = 0;
		const notify = vi.fn();
		const pi = {
			on(event: string, handler: (event: any, ctx: any) => unknown) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool() {},
			registerCommand() {},
			appendEntry() {},
			async exec(command: string, args: string[]) {
				if (command === "git" && args[0] === "rev-parse") return { stdout: "abc\n", stderr: "", code: 0, killed: false };
				if (command === "git" && args[0] === "status") {
					statusCalls += 1;
					return { stdout: statusCalls === 1 ? "" : " M generated.txt\n", stderr: "", code: 0, killed: false };
				}
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		} as unknown as ExtensionAPI;
		longHorizonExtension(pi);
		const ctx = {
			cwd,
			hasUI: false,
			ui: { notify, setStatus: vi.fn(), setWidget: vi.fn() },
			sessionManager: { getEntries: () => [] },
			signal: undefined,
			abort: vi.fn(),
		} as unknown as ExtensionContext;
		await handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
		await handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, ctx);
		const beforeResult = await handlers.get("before_agent_start")?.[1]?.({ systemPrompt: "base" }, ctx);
		await handlers.get("agent_end")?.[0]?.({ messages: [] }, ctx);

		expect((beforeResult as { message: { content: string } }).message.content).toContain(
			"run unowned: generated.txt",
		);
		expect(notify.mock.calls.at(-1)?.[0]).toContain("unowned: generated.txt");
	});

	it("rejects custom file operations through symlinked directories", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "long-horizon-symlink-cwd-"));
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "long-horizon-symlink-outside-"));
		await fs.writeFile(path.join(outside, "secret.txt"), "keep me\n");
		await fs.symlink(outside, path.join(cwd, "linked"), "dir");

		const tools = new Map<string, any>();
		const pi = {
			on() {},
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
			registerCommand() {},
			appendEntry() {},
		} as unknown as ExtensionAPI;
		longHorizonExtension(pi);
		const ctx = {
			cwd,
			hasUI: false,
			ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
			sessionManager: { getEntries: () => [] },
			signal: undefined,
			abort: vi.fn(),
		} as unknown as ExtensionContext;

		await expect(
			tools.get("long_horizon_delete").execute("delete-1", { path: "linked/secret.txt" }, undefined, undefined, ctx),
		).rejects.toThrow(/outside cwd|symlink/);
		await expect(fs.readFile(path.join(outside, "secret.txt"), "utf8")).resolves.toBe("keep me\n");
		await expect(
			tools.get("long_horizon_move").execute("move-1", { from: "linked/secret.txt", to: "moved.txt" }, undefined, undefined, ctx),
		).rejects.toThrow(/outside cwd|symlink/);
		await expect(fs.readFile(path.join(outside, "secret.txt"), "utf8")).resolves.toBe("keep me\n");
	});

	it("does not create a run when /lh status is queried", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "long-horizon-status-"));
		await fs.writeFile(path.join(cwd, "plan.md"), "### One\n<!-- id: one -->\n");
		await fs.writeFile(path.join(cwd, "progress.md"), "active: one\nattempts: 0\n");
		const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
		let command: any;
		const pi = {
			on(event: string, handler: (event: any, ctx: any) => unknown) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool() {},
			registerCommand(_name: string, definition: any) {
				command = definition;
			},
			appendEntry() {},
			async exec(tool: string, args: string[]) {
				if (tool === "git" && args[0] === "rev-parse") return { stdout: "abc\n", stderr: "", code: 0, killed: false };
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		} as unknown as ExtensionAPI;
		longHorizonExtension(pi);
		const ctx = {
			cwd,
			hasUI: false,
			ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
			sessionManager: { getEntries: () => [] },
			signal: undefined,
			abort: vi.fn(),
		} as unknown as ExtensionContext;

		await handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
		await command.handler("status", ctx);
		expect(await fs.readFile(path.join(cwd, "progress.md"), "utf8")).toContain("attempts: 0");
		await handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, ctx);
	});

	it("blocks built-in write through a symlinked parent before ownership is recorded", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "long-horizon-write-symlink-cwd-"));
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "long-horizon-write-symlink-outside-"));
		await fs.symlink(outside, path.join(cwd, "linked"), "dir");
		const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
		const tools = new Map<string, any>();
		const pi = {
			on(event: string, handler: (event: any, ctx: any) => unknown) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
			registerCommand() {},
			appendEntry() {},
		} as unknown as ExtensionAPI;
		longHorizonExtension(pi);
		const ctx = {
			cwd,
			hasUI: false,
			ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
			sessionManager: { getEntries: () => [] },
			signal: undefined,
			abort: vi.fn(),
		} as unknown as ExtensionContext;
		await handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);

		await handlers.get("tool_call")?.[0]?.(
			{ toolName: "write", toolCallId: "write-1", input: { path: "linked/new.txt" } },
			ctx,
		);
		await expect(
			tools.get("write").execute("write-1", { path: "linked/new.txt", content: "escape" }, undefined, undefined, ctx),
		).rejects.toThrow();
		await expect(fs.access(path.join(outside, "new.txt"))).rejects.toThrow();
	});

	it("overrides Pi write and edit with filesystem operations that reject symlink traversal", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "long-horizon-safe-tools-cwd-"));
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "long-horizon-safe-tools-outside-"));
		await fs.writeFile(path.join(outside, "secret.txt"), "secret\n");
		await fs.symlink(outside, path.join(cwd, "linked"), "dir");
		const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
		const tools = new Map<string, any>();
		const pi = {
			on(event: string, handler: (event: any, ctx: any) => unknown) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
			registerCommand() {},
			appendEntry() {},
		} as unknown as ExtensionAPI;
		longHorizonExtension(pi);
		const ctx = {
			cwd,
			hasUI: false,
			ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
			sessionManager: { getEntries: () => [] },
			signal: undefined,
			abort: vi.fn(),
		} as unknown as ExtensionContext;
		await handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);

		expect(tools.has("write")).toBe(true);
		expect(tools.has("edit")).toBe(true);
		await expect(
			tools.get("write").execute("write-1", { path: "linked/new.txt", content: "escape" }, undefined, undefined, ctx),
		).rejects.toThrow();
		await expect(
			tools.get("edit").execute(
				"edit-1",
				{ path: "linked/secret.txt", edits: [{ oldText: "secret", newText: "changed" }] },
				undefined,
				undefined,
				ctx,
			),
		).rejects.toThrow();
		await expect(fs.readFile(path.join(outside, "secret.txt"), "utf8")).resolves.toBe("secret\n");
	});

	it("uses safe custom delete and move implementations", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "long-horizon-safe-custom-"));
		await fs.writeFile(path.join(cwd, "from.txt"), "from");
		await fs.writeFile(path.join(cwd, "existing.txt"), "existing");
		const tools = new Map<string, any>();
		const pi = {
			on() {},
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
			registerCommand() {},
			appendEntry() {},
		} as unknown as ExtensionAPI;
		longHorizonExtension(pi);
		const ctx = {
			cwd,
			hasUI: false,
			ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
			sessionManager: { getEntries: () => [] },
			signal: undefined,
			abort: vi.fn(),
		} as unknown as ExtensionContext;

		await expect(
			tools.get("long_horizon_move").execute("move-1", { from: "from.txt", to: "existing.txt" }, undefined, undefined, ctx),
		).rejects.toThrow();
		await expect(fs.readFile(path.join(cwd, "from.txt"), "utf8")).resolves.toBe("from");
		await tools.get("long_horizon_move").execute("move-2", { from: "from.txt", to: "to.txt" }, undefined, undefined, ctx);
		await tools.get("long_horizon_delete").execute("delete-1", { path: "to.txt" }, undefined, undefined, ctx);
		await expect(fs.access(path.join(cwd, "to.txt"))).rejects.toThrow();
	});

	it("resets ownership after each section and excludes leftover dirty paths from the next commit", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "long-horizon-multi-ownership-"));
		await fs.writeFile(path.join(cwd, "plan.md"), "### One\n<!-- id: one -->\n### Two\n<!-- id: two -->\n");
		await fs.writeFile(path.join(cwd, "progress.md"), "active: one\nattempts: 0\n");
		const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
		const tools = new Map<string, any>();
		let command: any;
		let head = "abc";
		let status = "";
		const pi = {
			on(event: string, handler: (event: any, ctx: any) => unknown) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			registerTool(tool: any) {
				tools.set(tool.name, tool);
			},
			registerCommand(_name: string, definition: any) {
				command = definition;
			},
			appendEntry() {},
			async exec(tool: string, args: string[]) {
				if (tool !== "git") return { stdout: "", stderr: "", code: 0, killed: false };
				if (args[0] === "rev-parse") return { stdout: `${head}\n`, stderr: "", code: 0, killed: false };
				if (args[0] === "status") return { stdout: status, stderr: "", code: 0, killed: false };
				if (args[0] === "commit") {
					head = "def";
					status = "";
				}
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		} as unknown as ExtensionAPI;
		longHorizonExtension(pi);
		const ctx = {
			cwd,
			hasUI: false,
			ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
			sessionManager: { getEntries: () => [] },
			signal: undefined,
			abort: vi.fn(),
		} as unknown as ExtensionContext;

		await handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
		await command.handler("multi", ctx);
		await handlers.get("before_agent_start")?.[0]?.({ systemPrompt: "base" }, ctx);
		await handlers.get("tool_call")?.[0]?.({ toolName: "write", toolCallId: "write-1", input: { path: "owned.ts" } }, ctx);
		await handlers.get("tool_result")?.[0]?.({ toolName: "write", toolCallId: "write-1", isError: false }, ctx);
		status = " M owned.ts\0 M progress.md\0";
		const firstResult = await tools.get("complete_section").execute(
			"complete-1",
			{ id: "one", skipVerify: true },
			undefined,
			undefined,
			ctx,
		);
		expect(firstResult.content[0].text).toContain("next active: two");
		status = " M owned.ts\0";

		const nextQuery = await handlers.get("before_agent_start")?.[1]?.({ systemPrompt: "base" }, ctx);
		const dynamic = (nextQuery as { message: { content: string } }).message.content;
		expect(dynamic).toContain("run owned: <none>");
		expect(dynamic).toContain("run unowned: owned.ts");

		await handlers.get("tool_call")?.[0]?.({ toolName: "write", toolCallId: "write-2", input: { path: "second.ts" } }, ctx);
		await handlers.get("tool_result")?.[0]?.({ toolName: "write", toolCallId: "write-2", isError: false }, ctx);
		status = " M owned.ts\0 M second.ts\0 M progress.md\0";
		const secondResult = await tools.get("complete_section").execute(
			"complete-2",
			{ id: "two", skipVerify: true },
			undefined,
			undefined,
			ctx,
		);

		expect(secondResult.details.ok).toBe(true);
		expect(secondResult.details.commitPaths).toEqual(["progress.md", "second.ts"]);
		expect(secondResult.content[0].text).toContain("next active: <none>");
	});
});
