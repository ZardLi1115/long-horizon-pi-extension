import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import longHorizonExtension from "../index.js";

describe("Pi extension wiring", () => {
	it("does not implicitly execute plan metadata verify and commits successful owned edits", async () => {
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
				if (command === "sh") throw new Error("implicit verify was executed");
				if (command !== "git") return { stdout: "", stderr: "", code: 0, killed: false };
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

		const result = await tools.get("complete_section").execute("complete-1", { id: "one" }, undefined, undefined, ctx);

		expect(result.details.status).toBe("unverified");
		expect(execCalls.some(([command]) => command === "sh")).toBe(false);
		expect(execCalls).toContainEqual(["git", "add", "--", "progress.md", "src/file.ts"]);
		expect(execCalls).toContainEqual(["git", "commit", "-m", "long-horizon: complete one", "--", "progress.md", "src/file.ts"]);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(aborted).toBe(1);
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
				if (command === "git" && args[0] === "commit") order.push("commit");
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
		const result = await tools.get("complete_section").execute("complete-1", { id: "one" }, undefined, undefined, ctx);
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
		const contextResult = await handlers.get("context")?.[0]?.({ messages: [] }, ctx);

		expect(await fs.readFile(path.join(cwd, "plan.md"), "utf8")).toContain("<!-- id: first-section -->");
		expect((contextResult as { messages: Array<{ content: string }> }).messages.at(-1)?.content).toContain(
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
		const contextResult = await handlers.get("context")?.[0]?.({ messages: [] }, ctx);
		await handlers.get("agent_end")?.[0]?.({ messages: [] }, ctx);

		expect((contextResult as { messages: Array<{ content: string }> }).messages.at(-1)?.content).toContain(
			"run unowned: generated.txt",
		);
		expect(notify.mock.calls.at(-1)?.[0]).toContain("unowned: generated.txt");
	});
});
