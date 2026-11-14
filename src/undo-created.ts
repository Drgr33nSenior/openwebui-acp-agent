import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { directory, privateDir } from "./config.js";
import { root, target } from "./workspace.js";

export const RECOVERY_FILES = 100;
export const RECOVERY_BYTES = 10_000_000;
export class UndoRecoveryError extends Error {
  constructor(
    message: string,
    readonly recoveryPath?: string,
  ) {
    super(
      recoveryPath
        ? `${message}. Captured file retained for recovery at ${recoveryPath}`
        : message,
    );
  }
}
type Identity = { dev: bigint; ino: bigint; ctimeNs: bigint };
async function chain(workspace: string, parent: string): Promise<Identity[]> {
  const parts = relative(workspace, parent).split(sep).filter(Boolean);
  const result: Identity[] = [];
  let current = workspace;
  for (const part of ["", ...parts]) {
    if (part) current = join(current, part);
    const info = await lstat(current, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Symlink access refused");
    result.push(info);
  }
  return result;
}
function sameChain(a: Identity[], b: Identity[], captured = false) {
  return (
    a.length === b.length &&
    a.every(
      (item, i) =>
        item.dev === b[i]!.dev &&
        item.ino === b[i]!.ino &&
        ((captured && i === a.length - 1) || item.ctimeNs === b[i]!.ctimeNs),
    )
  );
}
async function exactContents(file: FileHandle, expected: Buffer) {
  const info = await file.stat();
  if (!info.isFile() || info.nlink !== 1 || info.size !== expected.length)
    return false;
  const bytes = Buffer.alloc(expected.length + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await file.read(
      bytes,
      offset,
      bytes.length - offset,
      offset,
    );
    if (!result.bytesRead) break;
    offset += result.bytesRead;
  }
  return bytes.subarray(0, offset).equals(expected);
}

// Linux procfs permits anchored directory traversal through an open FD. macOS
// /dev/fd exposes FD metadata but does not support /dev/fd/<dirfd>/<child> rename
// (verified ENOENT). Node has no renameat/fchdir API. Refuse on that platform;
// never replace this with a check-then-unlink or an unanchored rename fallback.
export async function quarantineCreatedFile(
  workspace: string,
  path: string,
  expected: string,
  signal: AbortSignal = AbortSignal.timeout(5000),
): Promise<{ recoveryPath: string }> {
  signal.throwIfAborted();
  if (process.platform !== "linux")
    throw new UndoRecoveryError(
      "Safe removal of created files is unavailable on this platform; delete the file in your IDE after checking its contents",
    );
  if ((await root(workspace)) !== workspace)
    throw new Error("Canonical workspace root required");
  const p = await target(workspace, path, true, true);
  const expectedBytes = Buffer.from(expected, "utf8");
  if (expectedBytes.length > 100_000 || expected.includes("\0"))
    throw new Error("Created-file recovery requires bounded text");
  const before = await chain(workspace, dirname(p));
  const sourceParent = await open(
    dirname(p),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let source: FileHandle | undefined;
  let destinationParent: FileHandle | undefined;
  let lock: FileHandle | undefined;
  let lockPath: string | undefined;
  let captured: string | undefined;
  try {
    const openedParent = await sourceParent.stat({ bigint: true });
    if (
      openedParent.dev !== before.at(-1)!.dev ||
      openedParent.ino !== before.at(-1)!.ino ||
      !sameChain(before, await chain(workspace, dirname(p)))
    )
      throw new Error("Workspace changed before recovery; nothing moved");
    const anchoredSource = `/proc/self/fd/${sourceParent.fd}/${basename(p)}`;
    source = await open(
      anchoredSource,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const sourceInfo = await source.stat({ bigint: true });
    if (
      sourceInfo.uid !== BigInt(process.getuid!()) ||
      !(await exactContents(source, expectedBytes))
    )
      throw new Error("Stale checkpoint: created file changed; nothing moved");
    await privateDir();
    const recovery = join(directory, "undo-recovery");
    await mkdir(recovery, { recursive: true, mode: 0o700 });
    const recoveryInfo = await lstat(recovery, { bigint: true });
    if (
      !recoveryInfo.isDirectory() ||
      recoveryInfo.isSymbolicLink() ||
      recoveryInfo.uid !== BigInt(process.getuid!()) ||
      recoveryInfo.mode & 0o077n
    )
      throw new Error(
        "Recovery directory must be private and owned by the current user",
      );
    destinationParent = await open(
      recovery,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const openedDestination = await destinationParent.stat({ bigint: true });
    if (
      openedDestination.dev !== recoveryInfo.dev ||
      openedDestination.ino !== recoveryInfo.ino
    )
      throw new Error("Recovery directory changed");
    const anchoredDestination = `/proc/self/fd/${destinationParent.fd}`;
    lockPath = join(anchoredDestination, ".lock");
    lock = await open(lockPath, "wx", 0o600).catch(() => {
      throw new Error("Recovery store busy or unsafe; no file moved");
    });
    const names = (await readdir(anchoredDestination)).filter(
      (name) => name !== ".lock",
    );
    if (names.length >= RECOVERY_FILES)
      throw new Error(
        "Recovery file limit reached; inspect retained recovery files manually",
      );
    let total = expectedBytes.length;
    for (const name of names) {
      const info = await lstat(join(anchoredDestination, name));
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.uid !== process.getuid!() ||
        info.mode & 0o077
      )
        throw new Error("Unsafe retained recovery file");
      total += info.size;
      if (total > RECOVERY_BYTES)
        throw new Error(
          "Recovery storage limit reached; inspect retained recovery files manually",
        );
    }
    signal.throwIfAborted();
    await target(workspace, path, true, true);
    if (
      !sameChain(before, await chain(workspace, dirname(p))) ||
      !(await exactContents(source, expectedBytes))
    )
      throw new Error(
        "Workspace or file changed before recovery; nothing moved",
      );
    const name = `${randomUUID()}.txt`;
    const destination = join(anchoredDestination, name);
    const placeholder = await open(destination, "wx", 0o600);
    await placeholder.close();
    try {
      await rename(anchoredSource, destination);
    } catch (error) {
      // This is the exclusively created empty application-state placeholder,
      // never a workspace file. A failed same-filesystem rename leaves source intact.
      await unlink(destination);
      const code = (error as NodeJS.ErrnoException).code;
      if (["EXDEV", "ENOENT", "ENOTDIR", "ENOSYS"].includes(code ?? ""))
        throw new UndoRecoveryError(
          "Safe anchored recovery is unavailable on this filesystem; no copy or delete fallback was attempted",
        );
      throw error;
    }
    captured = join(recovery, name);
    const moved = await lstat(destination, { bigint: true });
    if (
      !moved.isFile() ||
      moved.isSymbolicLink() ||
      moved.dev !== sourceInfo.dev ||
      moved.ino !== sourceInfo.ino ||
      !(await exactContents(source, expectedBytes)) ||
      !sameChain(before, await chain(workspace, dirname(p)), true)
    )
      throw new UndoRecoveryError(
        "File changed during recovery; no newer workspace file was overwritten",
        captured,
      );
    await source.chmod(0o600);
    await source.sync();
    await destinationParent.sync();
    await sourceParent.sync();
    signal.throwIfAborted();
    return { recoveryPath: captured };
  } catch (error) {
    if (captured && !(error instanceof UndoRecoveryError))
      throw new UndoRecoveryError(
        "Recovery interrupted after capture; inspect the retained file before retrying",
        captured,
      );
    throw error;
  } finally {
    try {
      await lock?.close();
      if (lockPath && lock) await unlink(lockPath);
    } finally {
      await Promise.allSettled([
        source?.close(),
        destinationParent?.close(),
        sourceParent.close(),
      ]);
    }
  }
}
