import { basename, dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

// Used by both file tools and the OS policy: modifying the broker or its
// dependencies would change what the next process executes outside the sandbox.
export function agentCodePaths(): string[] {
  const dist = dirname(fileURLToPath(import.meta.url));
  const paths = [
    dist,
    process.execPath,
    join(dirname(dist), "node_modules"),
    join(dirname(dist), "package.json"),
    join(dirname(dist), "package-lock.json"),
  ];
  for (let p = dirname(dist); p !== parse(p).root; p = dirname(p)) {
    if (basename(p) === "node_modules") paths.push(p);
  }
  return paths;
}
