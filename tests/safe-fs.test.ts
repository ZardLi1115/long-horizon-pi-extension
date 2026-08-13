import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { safeAccessFile, safeDeleteFile, safeMkdir, safeMoveFile, safeReadFile, safeWriteFile } from "../src/safe-fs.js";

describe("safe filesystem operations", () => {
	it("writes and reads a regular file while creating safe parent directories", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "long-horizon-safe-fs-"));

		await safeWriteFile(cwd, "nested/file.txt", "hello");

		await expect(safeReadFile(cwd, "nested/file.txt")).resolves.toEqual(Buffer.from("hello"));
		await expect(safeAccessFile(cwd, "nested/file.txt")).resolves.toBeUndefined();
	});

	it("treats creating the cwd itself as an already-satisfied mkdir", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "long-horizon-safe-root-"));

		await expect(safeMkdir(cwd, cwd)).resolves.toBeUndefined();
		await safeWriteFile(cwd, "root.txt", "root");
		await expect(fs.readFile(path.join(cwd, "root.txt"), "utf8")).resolves.toBe("root");
	});

	it("rejects write and read through a symlinked parent", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "long-horizon-safe-cwd-"));
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "long-horizon-safe-outside-"));
		await fs.writeFile(path.join(outside, "secret.txt"), "secret");
		await fs.symlink(outside, path.join(cwd, "linked"), "dir");

		await expect(safeWriteFile(cwd, "linked/new.txt", "escape")).rejects.toThrow();
		await expect(safeReadFile(cwd, "linked/secret.txt")).rejects.toThrow();
		await expect(fs.readFile(path.join(outside, "secret.txt"), "utf8")).resolves.toBe("secret");
	});

	it("moves without overwriting and deletes only files", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "long-horizon-safe-move-"));
		await fs.writeFile(path.join(cwd, "from.txt"), "from");
		await fs.writeFile(path.join(cwd, "existing.txt"), "existing");

		await expect(safeMoveFile(cwd, "from.txt", "existing.txt")).rejects.toThrow();
		await expect(fs.readFile(path.join(cwd, "from.txt"), "utf8")).resolves.toBe("from");
		await safeMoveFile(cwd, "from.txt", "to.txt");
		await expect(fs.readFile(path.join(cwd, "to.txt"), "utf8")).resolves.toBe("from");
		await safeDeleteFile(cwd, "to.txt");
		await expect(fs.access(path.join(cwd, "to.txt"))).rejects.toThrow();
	});
});
