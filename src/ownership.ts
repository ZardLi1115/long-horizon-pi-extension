import path from "node:path";

export interface OwnershipSnapshot {
	owned: string[];
	unowned: string[];
	pending: Array<{ toolCallId: string; path: string }>;
}

function sorted(values: Iterable<string>): string[] {
	return [...values].sort();
}

export class OwnershipTracker {
	private readonly cwd: string;
	private readonly pendingPaths = new Map<string, { toolName: string; path: string }>();
	private readonly ownedPaths = new Set<string>();
	private readonly unownedPaths = new Set<string>();
	private readonly expectedStates = new Map<string, string | null>();

	constructor(cwd: string) {
		this.cwd = path.resolve(cwd);
	}

	private normalize(input: string): string {
		const absolute = path.resolve(this.cwd, input);
		const relative = path.relative(this.cwd, absolute);
		if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			throw new Error(`path is outside cwd: ${input}`);
		}
		return relative.split(path.sep).join("/");
	}

	pending(toolCallId: string, toolName: string, inputPath: string): void {
		this.pendingPaths.set(toolCallId, { toolName, path: this.assertCanAcquire(inputPath) });
	}

	assertCanAcquire(inputPath: string, currentState?: string | null): string {
		const normalized = this.normalize(inputPath);
		if (currentState !== undefined && this.expectedStates.has(normalized) && this.expectedStates.get(normalized) !== currentState) {
			throw new Error(`owned path changed outside Long Horizon tools: ${normalized}`);
		}
		return normalized;
	}

	pendingPath(toolCallId: string): string | undefined {
		return this.pendingPaths.get(toolCallId)?.path;
	}

	result(toolCallId: string, isError: boolean, expectedState?: string | null): void {
		const pending = this.pendingPaths.get(toolCallId);
		if (!pending) return;
		this.pendingPaths.delete(toolCallId);
		if (!isError) {
			this.ownedPaths.add(pending.path);
			this.unownedPaths.delete(pending.path);
			if (expectedState !== undefined) this.expectedStates.set(pending.path, expectedState);
		}
	}

	customSuccess(toolName: string, paths: string[], expectedStates?: Map<string, string | null>): void {
		if (toolName !== "delete" && toolName !== "move") throw new Error(`unsupported custom ownership: ${toolName}`);
		for (const inputPath of paths) {
			const path = this.normalize(inputPath);
			this.ownedPaths.add(path);
			this.unownedPaths.delete(path);
			if (expectedStates?.has(inputPath)) this.expectedStates.set(path, expectedStates.get(inputPath) ?? null);
		}
	}

	markUnowned(inputPath: string): void {
		this.unownedPaths.add(this.normalize(inputPath));
	}

	snapshot(): OwnershipSnapshot {
		return {
			owned: sorted(this.ownedPaths),
			unowned: sorted(this.unownedPaths),
			pending: [...this.pendingPaths.entries()]
				.map(([toolCallId, pending]) => ({ toolCallId, path: pending.path }))
				.sort((a, b) => a.toolCallId.localeCompare(b.toolCallId)),
		};
	}

	owned(): Set<string> {
		return new Set(this.ownedPaths);
	}

	unowned(): Set<string> {
		return new Set(this.unownedPaths);
	}

	async validate(readState: (path: string) => Promise<string | null>): Promise<string[]> {
		const changed: string[] = [];
		for (const [path, expected] of this.expectedStates) {
			if ((await readState(path)) !== expected) changed.push(path);
		}
		return changed.sort();
	}
}
