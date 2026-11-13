// Standalone upstream reproduction. Run only on a disposable Linux test host.
// No agent configuration, credentials, server or project content is used.
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

if (process.platform !== "linux") throw new Error("Linux reproduction only");
const root = await mkdtemp("/tmp/openwebui-mount-repro-");
await mkdir(join(root, ".git"));
await writeFile(join(root, ".git/config"), "[core]\n");
process.chdir(root);
try {
  await SandboxManager.initialize({
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: {
      denyRead: ["/tmp"],
      allowRead: [root],
      allowWrite: [root],
      denyWrite: [
        ...(process.argv.includes("--ordered-denies")
          ? [join(root, ".git/hooks"), join(root, ".git/config")]
          : []),
        join(root, ".git"),
      ],
    },
  });
  const wrapped = await SandboxManager.wrapWithSandboxArgv(
    "/usr/bin/true",
    "/bin/sh",
    undefined,
    undefined,
    root,
  );
  try {
    await promisify(execFile)(wrapped.argv[0], wrapped.argv.slice(1), {
      cwd: root,
      timeout: 5000,
      maxBuffer: 4096,
    });
    process.stdout.write("Runtime mount reproduction passed\n");
  } catch (error) {
    process.stderr.write(String(error.stderr).slice(0, 4096));
    process.exitCode = 1;
  }
} finally {
  await SandboxManager.reset();
}
