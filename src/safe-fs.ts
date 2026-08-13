import { spawn } from "node:child_process";
import path from "node:path";

const PYTHON_HELPER = String.raw`
import errno
import os
import stat
import sys

action, root, *arguments = sys.argv[1:]
nofollow = getattr(os, "O_NOFOLLOW", 0)
directory = getattr(os, "O_DIRECTORY", 0)

def fail(message):
    raise RuntimeError(message)

def components(relative):
    if os.path.isabs(relative):
        fail(f"path is outside cwd: {relative}")
    if relative == ".":
        return []
    values = relative.split("/")
    if not values or any(value in ("", ".", "..") for value in values):
        fail(f"invalid relative path: {relative}")
    if values[0] == ".git":
        fail("refusing to mutate .git")
    return values

root_fd = os.open(root, os.O_RDONLY | directory | nofollow)

def open_directory(values, create=False):
    current = os.dup(root_fd)
    try:
        for value in values:
            try:
                next_fd = os.open(value, os.O_RDONLY | directory | nofollow, dir_fd=current)
            except FileNotFoundError:
                if not create:
                    raise
                os.mkdir(value, 0o777, dir_fd=current)
                next_fd = os.open(value, os.O_RDONLY | directory | nofollow, dir_fd=current)
            except OSError as error:
                if error.errno in (errno.ELOOP, errno.ENOTDIR):
                    fail(f"path traverses a symlink or non-directory: {value}")
                raise
            os.close(current)
            current = next_fd
        return current
    except Exception:
        os.close(current)
        raise

def open_parent(relative, create=False):
    values = components(relative)
    return open_directory(values[:-1], create), values[-1]

try:
    if action == "mkdir":
        fd = open_directory(components(arguments[0]), True)
        os.close(fd)
    elif action == "read":
        parent_fd, name = open_parent(arguments[0])
        try:
            file_fd = os.open(name, os.O_RDONLY | nofollow, dir_fd=parent_fd)
            try:
                while True:
                    data = os.read(file_fd, 1024 * 1024)
                    if not data:
                        break
                    sys.stdout.buffer.write(data)
            finally:
                os.close(file_fd)
        finally:
            os.close(parent_fd)
    elif action == "access":
        parent_fd, name = open_parent(arguments[0])
        try:
            file_fd = os.open(name, os.O_RDWR | nofollow, dir_fd=parent_fd)
            os.close(file_fd)
        finally:
            os.close(parent_fd)
    elif action == "write":
        parent_fd, name = open_parent(arguments[0], True)
        try:
            file_fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | nofollow, 0o666, dir_fd=parent_fd)
            try:
                data = sys.stdin.buffer.read()
                offset = 0
                while offset < len(data):
                    offset += os.write(file_fd, data[offset:])
            finally:
                os.close(file_fd)
        finally:
            os.close(parent_fd)
    elif action == "delete":
        parent_fd, name = open_parent(arguments[0])
        try:
            info = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                fail("refusing to delete a directory")
            os.unlink(name, dir_fd=parent_fd)
        finally:
            os.close(parent_fd)
    elif action == "move":
        source_fd, source_name = open_parent(arguments[0])
        target_fd, target_name = open_parent(arguments[1])
        try:
            info = os.stat(source_name, dir_fd=source_fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                fail("refusing to move a directory")
            os.link(source_name, target_name, src_dir_fd=source_fd, dst_dir_fd=target_fd, follow_symlinks=False)
            try:
                os.unlink(source_name, dir_fd=source_fd)
            except Exception:
                os.unlink(target_name, dir_fd=target_fd)
                raise
        finally:
            os.close(source_fd)
            os.close(target_fd)
    else:
        fail(f"unsupported action: {action}")
finally:
    os.close(root_fd)
`;

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

async function runHelper(action: string, cwd: string, paths: string[], input?: Buffer): Promise<Buffer> {
	const relativePaths = paths.map((value) => relativePath(cwd, value, action === "mkdir"));
	return new Promise((resolve, reject) => {
		const child = spawn("python3", ["-c", PYTHON_HELPER, action, path.resolve(cwd), ...relativePaths], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve(Buffer.concat(stdout));
			else reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `safe filesystem helper exited with ${code}`));
		});
		child.stdin.end(input);
	});
}

export async function safeMkdir(cwd: string, directoryPath: string): Promise<void> {
	await runHelper("mkdir", cwd, [directoryPath]);
}

export async function safeReadFile(cwd: string, filePath: string): Promise<Buffer> {
	return runHelper("read", cwd, [filePath]);
}

export async function safeAccessFile(cwd: string, filePath: string): Promise<void> {
	await runHelper("access", cwd, [filePath]);
}

export async function safeWriteFile(cwd: string, filePath: string, content: string): Promise<void> {
	await runHelper("write", cwd, [filePath], Buffer.from(content));
}

export async function safeDeleteFile(cwd: string, filePath: string): Promise<void> {
	await runHelper("delete", cwd, [filePath]);
}

export async function safeMoveFile(cwd: string, from: string, to: string): Promise<void> {
	await runHelper("move", cwd, [from, to]);
}

export function safeRelativePath(cwd: string, input: string): string {
	return relativePath(cwd, input);
}
