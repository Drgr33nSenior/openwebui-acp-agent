// The sandbox broker's Unix socket paths. macOS limits a socket path to 104
// bytes, including the terminator; the runtime binds its proxy backend socket
// in the broker's os.tmpdir(). Below a long TMPDIR, sandbox initialization
// failed on macOS 26 before the broker received its own short directory.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { release, tmpdir } from "node:os";
import { brokerTemporary, sandboxCommand } from "../dist/sandbox.js";

const posix = ["darwin", "linux"].includes(process.platform);

// Evidence, not a requirement: which socket path lengths this host binds.
test(
  "socket path lengths this host accepts (diagnostic)",
  { skip: !posix && "Unix sockets are not used on this platform" },
  async (t) => {
    const base = await realpath(
      await mkdtemp(
        join(
          process.platform === "darwin" ? "/private/tmp" : "/tmp",
          "ow-sun-",
        ),
      ),
    );
    const results = {};
    try {
      for (const bytes of [100, 103, 104, 107, 108, 120]) {
        const path = join(base, "s".repeat(bytes - base.length - 1));
        assert.equal(Buffer.byteLength(path), bytes);
        const server = createServer();
        results[bytes] = await new Promise((done) => {
          server.once("error", (error) => done(error.code ?? "error"));
          server.listen(path, () => server.close(() => done("bound")));
        });
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
    t.diagnostic(
      JSON.stringify({
        platform: process.platform,
        release: release(),
        node: process.version,
        results,
      }),
    );
    assert.equal(results[100], "bound");
  },
);

test(
  "the macOS broker directory is private, short and apart from command scratch",
  {
    skip:
      process.platform !== "darwin" &&
      "macOS only: other platforms keep the broker in command scratch",
  },
  async () => {
    const path = await brokerTemporary();
    try {
      assert.match(path, /^\/private\/tmp\/openwebui-broker-[A-Za-z0-9]{6}$/);
      assert.equal((await stat(path)).mode & 0o777, 0o700);
      assert(
        Buffer.byteLength(join(path, "srt-mux-99999999-zzzzzz.sock")) <= 103,
      );
    } finally {
      await rm(path, { recursive: true, force: true });
    }
    assert.equal(await brokerTemporary("linux"), undefined);
  },
);

// The failure itself: a real sandboxed command below a long TMPDIR. Without
// the broker directory, its backend socket path is about 150 bytes here.
test(
  "a sandboxed command works below a long TMPDIR on macOS, with private scratch and denials intact",
  {
    skip:
      process.platform !== "darwin" &&
      "macOS fix; Linux keeps bridge sockets in command scratch (sun_path 108)",
  },
  async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "ow-long-tmp-")));
    const longTmp = join(base, "t".repeat(Math.max(1, 100 - base.length - 1)));
    await mkdir(longTmp);
    assert(Buffer.byteLength(longTmp) >= 100);
    const root = join(base, "workspace");
    // Below the denied TMPDIR, like the hidden sources of the benchmark.
    const sibling = join(longTmp, "sibling");
    await mkdir(root);
    await mkdir(sibling);
    await writeFile(join(root, "public.txt"), "control-nonce");
    await writeFile(join(sibling, "private.txt"), "outside-content");
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = longTmp;
    try {
      assert.equal(tmpdir(), longTmp);
      const result = JSON.parse(
        await sandboxCommand(
          process.execPath,
          [
            "-e",
            `const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
             const scratch=path.join(os.tmpdir(),'scratch.txt');fs.writeFileSync(scratch,'s');
             let outside='denied';try{outside=fs.readFileSync(${JSON.stringify(join(sibling, "private.txt"))},'utf8')}catch{}
             let broker='denied';try{broker=fs.readdirSync('/private/tmp').length}catch{}
             console.log(JSON.stringify({control:fs.readFileSync('public.txt','utf8'),scratch,outside,broker}))`,
          ],
          { mode: "workspace", root, network: async () => false },
          AbortSignal.timeout(30000),
        ),
      );
      assert.equal(result.code, 0, result.output);
      const seen = JSON.parse(result.output);
      assert.equal(seen.control, "control-nonce");
      assert.equal(seen.outside, "denied");
      // The broker's own directory is below /private/tmp, which stays denied.
      assert.equal(seen.broker, "denied");
      // Command scratch is still the invocation's directory below TMPDIR.
      assert(
        seen.scratch.startsWith(join(longTmp, "openwebui-sandbox-")),
        seen.scratch,
      );
      await assert.rejects(access(seen.scratch));
      assert.deepEqual(await readdir(longTmp), ["sibling"]);
    } finally {
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
      await rm(base, { recursive: true, force: true });
    }
  },
);
