import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  realpath,
  link,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
const { readText, atomicEdit } = await import("../dist/workspace.js");

// A concurrent process in the workspace flips a folder between a real directory
// and a symlink to a directory outside the root, as fast as it can. The file
// tools check the path, then use it: they must never read or write through the
// symlink, whatever the timing.
async function racing(root, outside, run) {
  const flipper = spawn(
    process.execPath,
    [
      "-e",
      `const fs=require('node:fs');const [d,real,out]=process.argv.slice(1);
       const spin=()=>{const n=Math.random()*20000;for(let i=0;i<n;i++);};
       for(;;){try{fs.renameSync(d,real)}catch{}try{fs.symlinkSync(out,d)}catch{}spin();
               try{fs.unlinkSync(d)}catch{}try{fs.renameSync(real,d)}catch{}spin();}`,
      join(root, "d"),
      join(root, "d-real"),
      outside,
    ],
    { stdio: "ignore" },
  );
  try {
    return await run();
  } finally {
    flipper.kill("SIGKILL");
    await new Promise((r) => flipper.once("exit", r));
  }
}
async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), "ow-race-")));
  const root = join(base, "root"),
    outside = join(base, "outside");
  await mkdir(join(root, "d"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(root, "d", "f.txt"), "inside");
  await writeFile(join(outside, "f.txt"), "OUTSIDE-SECRET");
  return { base, root, outside };
}

test("reads never return a file reached through a folder swapped for a symlink", async () => {
  const { base, root, outside } = await fixture();
  let inside = 0;
  const leaked = await racing(root, outside, async () => {
    const deadline = Date.now() + 8000;
    let leaks = 0;
    while (Date.now() < deadline) {
      try {
        const text = await readText(root, join(root, "d", "f.txt"));
        if (text === "OUTSIDE-SECRET") leaks++;
        else if (text === "inside") inside++;
      } catch {
        /* Refusing or failing during the race is the safe outcome. */
      }
    }
    return leaks;
  });
  await rm(base, { recursive: true, force: true });
  assert.equal(leaked, 0, "outside content was read through the symlink");
  assert(inside > 0, "no read succeeded between swaps");
});

test("writes never land in a folder swapped for a symlink", async () => {
  const { base, root, outside } = await fixture();
  await racing(root, outside, async () => {
    const deadline = Date.now() + 8000;
    let version = 0;
    while (Date.now() < deadline) {
      try {
        const before = await readText(root, join(root, "d", "f.txt"));
        await atomicEdit(root, "d/f.txt", before, `inside-${++version}`);
      } catch {
        /* A refused or failed write is the safe outcome. */
      }
    }
  });
  assert.equal(
    await readFile(join(outside, "f.txt"), "utf8"),
    "OUTSIDE-SECRET",
  );
  // A temporary file created through the swapped folder is caught before any
  // content is written; at most an empty file is left behind.
  for (const name of (await readdir(outside)).filter((n) => n !== "f.txt")) {
    assert.match(name, /^\.acp-/);
    assert.equal((await readFile(join(outside, name), "utf8")).length, 0, name);
  }
  await rm(base, { recursive: true, force: true });
});

test("final symlinks, hard links and special files are refused without blocking", async () => {
  const { base, root, outside } = await fixture();
  const { symlink } = await import("node:fs/promises");
  await symlink(join(outside, "f.txt"), join(root, "link.txt"));
  await assert.rejects(readText(root, join(root, "link.txt")), /Symlink/);
  await link(join(outside, "f.txt"), join(root, "hard.txt"));
  await assert.rejects(readText(root, join(root, "hard.txt")), /Hard-linked/);
  if (process.platform !== "win32") {
    execFileSync("mkfifo", [join(root, "pipe")]);
    await assert.rejects(readText(root, join(root, "pipe")), /bounded text/);
  }
  await rm(base, { recursive: true, force: true });
});
