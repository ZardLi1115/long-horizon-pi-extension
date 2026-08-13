import fs from "node:fs/promises";
import path from "node:path";

const NO_FOLLOW = process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0);

function relativePath(cwd: string, input: string, allowRoot = false): string {
	const root = path.resolve(cwd);
	const absolute = path.resolve(root, input);
	const relative = path.relative(root, absolute);
	if (!relative) {
		if (allowRoot) return ".";
		throw new Error(`path is outside cwd: ${input}`);
	}
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`path is outside cwd: ${input}`);
	}
	const normalized = relative.split(path.sep).join("/");
	if (normalized === ".git" || normalized.startsWith(".git/")) throw new Error("refusing to mutate .git");
	return normalized;
}

function components(relative: string): string[] {
	if (relative === ".") return [];
	const values = relative.split("/");
	if (values.some((value) => !value || value === "." || value === "..")) {
		throw new Error(`invalid relative path: ${relative}`);
	}
	return values;
}

async function assertSafePath(cwd: string, relative: string, allowMissingLeaf = false): Promise<void> {
	const values = components(relative);
	let current = path.resolve(cwd);
	for (let index = 0; index < values.length; index += 1) {
		current = path.join(current, values[index]);
		try {
			const info = await fs.lstat(current);
			if (info.isSymbolicLink()) throw new Error(`path traverses a symlink: ${relative}`);
			if (index < values.length - 1 && !info.isDirectory()) {
				throw new Error(`path traverses a non-directory: ${relative}`);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissingLeaf && index === values.length - 1) return;
			throw error;
		}
	}
}

async function ensureDirectory(cwd: string, relative: string): Promise<void> {
	const values = components(relative);
	let current = path.resolve(cwd);
	for (const value of values) {
		current = path.join(current, value);
		try {
			const info = await fs.lstat(current);
			if (info.isSymbolicLink()) throw new Error(`path traverses a symlink: ${relative}`);
			if (!info.isDirectory()) throw new Error(`path is not a directory: ${relative}`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			await fs.mkdir(current);
		}
	}
}

async function assertSafeLeaf(cwd: string, relative: string, allowMissing = false): Promise<void> {
	await assertSafePath(cwd, relative, allowMissing);
}

export async function safeMkdir(cwd: string, directoryPath: string): Promise<void> {
	const relative = relativePath(cwd, directoryPath, true);
	await ensureDirectory(cwd, relative);
}

export async function safeReadFile(cwd: string, filePath: string): Promise<Buffer> {
	const relative = relativePath(cwd, filePath);
	await assertSafeLeaf(cwd, relative);
	const handle = await fs.open(path.resolve(cwd, relative), fs.constants.O_RDONLY | NO_FOLLOW);
	try {
		return await handle.readFile();
	} finally {
		await handle.close();
	}
}

export async function safeAccessFile(cwd: string, filePath: string): Promise<void> {
	const relative = relativePath(cwd, filePath);
	await assertSafeLeaf(cwd, relative);
	const handle = await fs.open(path.resolve(cwd, relative), fs.constants.O_RDWR | NO_FOLLOW);
	await handle.close();
}

export async function safeWriteFile(cwd: string, filePath: string, content: string): Promise<void> {
	const relative = relativePath(cwd, filePath);
	const values = components(relative);
	const parent = values.slice(0, -1).join("/") || ".";
	await ensureDirectory(cwd, parent);
	await assertSafeLeaf(cwd, relative, true);
	const handle = await fs.open(
		path.resolve(cwd, relative),
		fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | NO_FOLLOW,
		0o666,
	);
	try {
		await handle.writeFile(content, "utf8");
	} finally {
		await handle.close();
	}
}

export async function safeDeleteFile(cwd: string, filePath: string): Promise<void> {
	const relative = relativePath(cwd, filePath);
	await assertSafeLeaf(cwd, relative);
	const target = path.resolve(cwd, relative);
	const info = await fs.lstat(target);
	if (info.isDirectory()) throw new Error("refusing to delete a directory");
	await fs.unlink(target);
}

export async function safeMoveFile(cwd: string, from: string, to: string): Promise<void> {
	const source = relativePath(cwd, from);
	const target = relativePath(cwd, to);
	const targetValues = components(target);
	const parent = targetValues.slice(0, -1).join("/") || ".";
	await assertSafeLeaf(cwd, source);
	await ensureDirectory(cwd, parent);
	await assertSafeLeaf(cwd, target, true);
	const sourceAbsolute = path.resolve(cwd, source);
	const targetAbsolute = path.resolve(cwd, target);
	const sourceInfo = await fs.lstat(sourceAbsolute);
	if (sourceInfo.isDirectory()) throw new Error("refusing to move a directory");
	try {
		await fs.link(sourceAbsolute, targetAbsolute);
	} catch (error) {
		throw error;
	}
	try {
		await fs.unlink(sourceAbsolute);
	} catch (error) {
		await fs.unlink(targetAbsolute).catch(() => undefined);
		throw error;
	}
}

export function safeRelativePath(cwd: string, input: string): string {
	return relativePath(cwd, input);
}
