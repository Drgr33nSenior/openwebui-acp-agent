import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  symlink,
  link,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  collectInstructions,
  instructionContext,
  INSTRUCTION_BYTES,
  INSTRUCTION_DEPTH,
} from "../dist/instructions.js";
const signal = () => AbortSignal.timeout(5000);
async function workspace() {
  const temp = await realpath(
    await mkdtemp(join(tmpdir(), "ow-instructions-")),
  );
  const root = join(temp, "project");
  await mkdir(root);
  return { temp, root, read: (path) => readFile(join(root, path), "utf8") };
}

test("nested guidance follows root-to-target scope and reads current editor contents", async () => {
  const { root, read } = await workspace();
  await mkdir(join(root, "src", "nested"), { recursive: true });
  await mkdir(join(root, "sibling"));
  await writeFile(join(root, "AGENTS.md"), "root guidance");
  await writeFile(join(root, "src", "AGENTS.md"), "src guidance on disk");
  await writeFile(join(root, "src", "nested", "AGENTS.md"), "nested guidance");
  await writeFile(join(root, "sibling", "AGENTS.md"), "must not read sibling");
  const reads = [];
  const instructions = await collectInstructions(
    root,
    "src/nested/new.ts",
    async (path) => {
      reads.push(path);
      return path === "src/AGENTS.md" ? "unsaved src guidance" : read(path);
    },
    signal(),
  );
  assert.deepEqual(
    instructions.map((v) => [v.path, v.scope]),
    [
      ["AGENTS.md", "."],
      ["src/AGENTS.md", "src"],
      ["src/nested/AGENTS.md", "src/nested"],
    ],
  );
  assert.deepEqual(reads, [
    "AGENTS.md",
    "src/AGENTS.md",
    "src/nested/AGENTS.md",
  ]);
  assert.equal(instructions[1].content, "unsaved src guidance");
  assert.match(
    instructionContext(instructions),
    /deeper directory guidance takes precedence/,
  );
  assert.match(
    instructionContext(instructions),
    /cannot override agent policy/,
  );
  await writeFile(join(root, "AGENTS.md"), "changed root guidance");
  assert.equal(
    (
      await collectInstructions(root, ".", read, signal(), { directory: true })
    )[0].content,
    "changed root guidance",
  );
  assert.equal(
    (
      await collectInstructions(root, "src", read, signal(), {
        directory: true,
      })
    ).length,
    2,
  );
});

test("instruction lookup refuses outside scope, traversal, symlinks and hard links before reading", async () => {
  const { temp, root, read } = await workspace();
  const sibling = join(temp, "other");
  await mkdir(sibling);
  await writeFile(join(sibling, "AGENTS.md"), "outside data");
  await symlink(sibling, join(root, "escape"));
  for (const path of [
    "../other/x.ts",
    join(sibling, "x.ts"),
    "escape/x.ts",
    ".env",
  ])
    await assert.rejects(
      collectInstructions(
        root,
        path,
        () => {
          throw Error("Unexpected read");
        },
        signal(),
      ),
      /scope|sensitive|Symlink/,
    );
  await symlink(join(sibling, "AGENTS.md"), join(root, "AGENTS.md"));
  await assert.rejects(
    collectInstructions(root, "file.ts", read, signal()),
    /Symlink/,
  );
  const separate = await workspace();
  await writeFile(join(separate.temp, "shared"), "guidance");
  await link(join(separate.temp, "shared"), join(separate.root, "AGENTS.md"));
  await assert.rejects(
    collectInstructions(separate.root, "file.ts", separate.read, signal()),
    /bounded regular/,
  );
});

test("missing guidance is optional but denied reads and binary/oversized instructions fail clearly", async () => {
  const { root, read } = await workspace();
  assert.deepEqual(
    await collectInstructions(root, "new.ts", read, signal()),
    [],
  );
  await writeFile(join(root, "AGENTS.md"), "guidance");
  await assert.rejects(
    collectInstructions(
      root,
      "new.ts",
      () => {
        throw Error("Client denied");
      },
      signal(),
    ),
    /Client denied/,
  );
  await assert.rejects(
    collectInstructions(root, "new.ts", async () => "binary\0text", signal()),
    /Binary/,
  );
  await assert.rejects(
    collectInstructions(
      root,
      "new.ts",
      async () => "x".repeat(INSTRUCTION_BYTES + 1),
      signal(),
    ),
    /byte limit/,
  );
  await writeFile(join(root, "AGENTS.md"), "x".repeat(INSTRUCTION_BYTES + 1));
  await assert.rejects(
    collectInstructions(
      root,
      "new.ts",
      () => {
        throw Error("Unexpected read");
      },
      signal(),
    ),
    /bounded regular/,
  );
});

test("instruction cancellation, aggregate bytes and depth are bounded", async () => {
  const { root, read } = await workspace();
  await mkdir(join(root, "child"));
  await writeFile(join(root, "AGENTS.md"), "a".repeat(40000));
  await writeFile(join(root, "child", "AGENTS.md"), "b".repeat(30000));
  await assert.rejects(
    collectInstructions(root, "child/file.ts", read, signal()),
    /byte limit/,
  );
  const controller = new AbortController();
  await assert.rejects(
    collectInstructions(
      root,
      "child/file.ts",
      async (path) => {
        controller.abort();
        return read(path);
      },
      controller.signal,
    ),
    /abort/i,
  );
  const deep = Array.from({ length: INSTRUCTION_DEPTH }, () => "d").join("/");
  await mkdir(join(root, deep), { recursive: true });
  await assert.rejects(
    collectInstructions(
      root,
      `${deep}/file.ts`,
      () => {
        throw Error("Unexpected read");
      },
      signal(),
    ),
    /depth limit/,
  );
});
