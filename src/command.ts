import { spawn } from "node:child_process";

export interface CommandResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

export interface CommandOptions {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	timeout?: number;
	signal?: AbortSignal;
	input?: string | Buffer;
}

function shellInvocation(command: string): { executable: string; args: string[] } {
	if (process.platform === "win32") {
		return { executable: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command] };
	}
	return { executable: process.env.SHELL || "/bin/sh", args: ["-lc", command] };
}

export function runCommand(executable: string, args: string[], options: CommandOptions): Promise<CommandResult> {
	return new Promise((resolve) => {
		const child = spawn(executable, args, {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let killed = false;
		let settled = false;
		let timeoutId: NodeJS.Timeout | undefined;

		const finish = (result: CommandResult) => {
			if (settled) return;
			settled = true;
			if (timeoutId) clearTimeout(timeoutId);
			if (options.signal) options.signal.removeEventListener("abort", kill);
			resolve(result);
		};
		const kill = () => {
			if (killed) return;
			killed = true;
			child.kill();
		};

		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => {
			finish({ stdout, stderr: `${stderr}${error.message}`, code: 1, killed });
		});
		child.on("close", (code) => {
			finish({ stdout, stderr, code: code ?? 1, killed });
		});

		if (options.signal) {
			if (options.signal.aborted) kill();
			else options.signal.addEventListener("abort", kill, { once: true });
		}
		if (options.timeout && options.timeout > 0) timeoutId = setTimeout(kill, options.timeout);
		child.stdin.end(options.input);
	});
}

export function runShellCommand(command: string, options: CommandOptions): Promise<CommandResult> {
	const invocation = shellInvocation(command);
	return runCommand(invocation.executable, invocation.args, options);
}
