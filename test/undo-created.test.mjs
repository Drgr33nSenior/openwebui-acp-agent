import test from "node:test";
import assert from "node:assert/strict";
import { watch } from "node:fs";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  access,
  readdir,
  symlink,
  stat,
  rename,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const temporary = await realpath(
  await mkdtemp(join(tmpdir(), "ow-undo-created-")),
);
process.env.OPENWEBUI_ACP_HOME = join(temporary, "state");
const { quarantineCreatedFile, RECOVERY_FILES } =
  await import("../dist/undo-created.js");
const { privateDir } = await import("../dist/config.js");
const supported = process.platform === "linux";
async function project() {
  const root = await mkdtemp(join(temporary, "workspace-"));
  await writeFile(join(root, "created.txt"), "created content");
  return root;
}

test(
  "created-file undo refuses unsupported platforms without mutating files or creating state",
  { skip: supported },
  async () => {
    const root = await project();
    await assert.rejects(
      quarantineCreatedFile(root, "created.txt", "created content"),
      /unavailable on this platform/,
    );
    assert.equal(
      await readFile(join(root, "created.txt"), "utf8"),
      "created content",
    );
    await assert.rejects(access(process.env.OPENWEBUI_ACP_HOME));
  },
);

test(
  "Linux creation undo retains exact file bytes in private same-filesystem recovery",
  { skip: !supported },
  async () => {
    const root = await project();
    const original = await stat(join(root, "created.txt"));
    const { recoveryPath } = await quarantineCreatedFile(
      root,
      "created.txt",
      "created content",
    );
    await assert.rejects(access(join(root, "created.txt")));
    assert.equal(await readFile(recoveryPath, "utf8"), "created content");
    const moved = await stat(recoveryPath);
    assert.equal(moved.ino, original.ino);
    assert.equal(moved.dev, original.dev);
    assert.equal(moved.mode & 0o777, 0o600);
    assert.equal(
      (await stat(join(process.env.OPENWEBUI_ACP_HOME, "undo-recovery"))).mode &
        0o777,
      0o700,
    );
    assert(
      !(
        await readdir(join(process.env.OPENWEBUI_ACP_HOME, "undo-recovery"))
      ).includes(".lock"),
    );
  },
);

test(
  "Linux recovery rejects stale files, secrets, symlinks, outside paths and cancelled work",
  { skip: !supported },
  async () => {
    const root = await project();
    await assert.rejects(
      quarantineCreatedFile(root, "created.txt", "stale"),
      /Stale/,
    );
    await writeFile(join(root, ".env"), "synthetic fixture");
    await assert.rejects(
      quarantineCreatedFile(root, ".env", "synthetic fixture"),
      /sensitive/,
    );
    const outside = await project();
    await symlink(outside, join(root, "escape"));
    await assert.rejects(
      quarantineCreatedFile(root, "escape/created.txt", "created content"),
      /Symlink/,
    );
    await assert.rejects(
      quarantineCreatedFile(
        root,
        join(outside, "created.txt"),
        "created content",
      ),
      /scope/,
    );
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      quarantineCreatedFile(
        root,
        "created.txt",
        "created content",
        controller.signal,
      ),
      /abort/i,
    );
    assert.equal(
      await readFile(join(root, "created.txt"), "utf8"),
      "created content",
    );
    assert.equal(
      await readFile(join(outside, "created.txt"), "utf8"),
      "created content",
    );
  },
);

test(
  "Linux recovery rejects protected agent files before checking their content",
  { skip: !supported },
  async () => {
    const root = await realpath(fileURLToPath(new URL("..", import.meta.url)));
    const path = join(root, "package.json");
    const original = await readFile(path);
    const identity = await stat(path);
    // Intentionally mismatched content makes this regression harmless even if
    // the early protection check disappears: the stale check must stop capture.
    await assert.rejects(
      quarantineCreatedFile(
        root,
        "package.json",
        "synthetic non-matching text",
      ),
      /Agent executable and dependency files are protected/,
    );
    assert.deepEqual(await readFile(path), original);
    assert.equal((await stat(path)).ino, identity.ino);
  },
);

test(
  "Linux cross-filesystem recovery refuses without copy or deletion",
  { skip: !supported },
  async (t) => {
    let shared;
    try {
      shared = await stat("/dev/shm");
    } catch {
      t.skip("No separate shared-memory filesystem");
      return;
    }
    if (shared.dev === (await stat(temporary)).dev) {
      t.skip("Shared-memory and test-state filesystems are the same");
      return;
    }
    const root = await realpath(await mkdtemp("/dev/shm/ow-undo-exdev-"));
    await writeFile(join(root, "created.txt"), "created content");
    await assert.rejects(
      quarantineCreatedFile(root, "created.txt", "created content"),
      /unavailable on this filesystem/,
    );
    assert.equal(
      await readFile(join(root, "created.txt"), "utf8"),
      "created content",
    );
  },
);

test(
  "Linux directory replacement cannot redirect recovery into an outside tree",
  { skip: !supported },
  async () => {
    const root = await project();
    const outside = await project();
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "sub", "created.txt"), "created content");
    await writeFile(join(outside, "created.txt"), "outside content");
    await privateDir();
    const recovery = join(process.env.OPENWEBUI_ACP_HOME, "undo-recovery");
    await mkdir(recovery, { recursive: true, mode: 0o700 });
    let swapped = false;
    let started = false;
    let resolveSwap;
    let rejectSwap;
    const swap = new Promise((resolve, reject) => {
      resolveSwap = resolve;
      rejectSwap = reject;
    });
    const watcher = watch(recovery, (_event, name) => {
      if (name !== ".lock" || started) return;
      started = true;
      void (async () => {
        await rename(join(root, "sub"), join(root, "original-sub"));
        await symlink(outside, join(root, "sub"));
        swapped = true;
        resolveSwap();
      })().catch(rejectSwap);
    });
    const timeout = setTimeout(
      () => rejectSwap(new Error("Recovery lock event not observed")),
      5000,
    );
    try {
      const [result] = await Promise.all([
        quarantineCreatedFile(root, "sub/created.txt", "created content").catch(
          (error) => error,
        ),
        swap,
      ]);
      assert.equal(swapped, true);
      assert.equal(
        await readFile(join(outside, "created.txt"), "utf8"),
        "outside content",
      );
      if (result.recoveryPath)
        assert.equal(
          await readFile(result.recoveryPath, "utf8"),
          "created content",
        );
      else
        assert.equal(
          await readFile(join(root, "original-sub", "created.txt"), "utf8"),
          "created content",
        );
    } finally {
      clearTimeout(timeout);
      watcher.close();
    }
  },
);

test(
  "Linux recovery quota fails before moving a file",
  { skip: !supported },
  async () => {
    const root = await project();
    await privateDir();
    const recovery = join(process.env.OPENWEBUI_ACP_HOME, "undo-recovery");
    await mkdir(recovery, { recursive: true, mode: 0o700 });
    const existing = (await readdir(recovery)).length;
    for (let i = existing; i < RECOVERY_FILES; i++)
      await writeFile(join(recovery, `quota-${i}.txt`), "quota fixture", {
        mode: 0o600,
      });
    await assert.rejects(
      quarantineCreatedFile(root, "created.txt", "created content"),
      /file limit/,
    );
    assert.equal(
      await readFile(join(root, "created.txt"), "utf8"),
      "created content",
    );
    assert(!(await readdir(recovery)).includes(".lock"));
  },
);
