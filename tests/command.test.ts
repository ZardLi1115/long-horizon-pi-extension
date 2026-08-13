import { describe, expect, it } from "vitest";
import { runCommand, runShellCommand } from "../src/command.js";

describe("command execution", () => {
	it("passes environment variables directly without an env executable", async () => {
		const result = await runCommand(
			process.execPath,
			["-e", "process.stdout.write(process.env.LONG_HORIZON_TEST ?? '')"],
			{ cwd: process.cwd(), env: { LONG_HORIZON_TEST: "present" } },
		);

		expect(result).toMatchObject({ code: 0, stdout: "present" });
	});

	it("runs shell verification through the configured shell command", async () => {
		const result = await runShellCommand("printf shell-ok", { cwd: process.cwd() });

		expect(result).toMatchObject({ code: 0, stdout: "shell-ok" });
	});
});
