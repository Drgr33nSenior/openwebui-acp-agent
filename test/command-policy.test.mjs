import test from "node:test";
import assert from "node:assert/strict";
import { repeatableCommand, grant } from "../dist/permissions.js";

test("ordinary inspection, test commands and literal shell forms offer exact repeat approval", () => {
  for (const [exe, args] of [
    ["ls", ["-la"]],
    ["find", [".", "-type", "f", "-name", "*.ts"]],
    ["rg", ["TODO", "."]],
    ["git", ["-C", "project", "status", "--short"]],
    ["npm", ["test"]],
    ["sh", ["-c", "npm test"]],
    ["/bin/bash", ["-lc", "ls -la"]],
    ["/bin/zsh", ["-c", "find . -name '*.ts' | head -20"]],
    ["bash", ["-lc", 'cd "folder with spaces" && git status']],
    ["sh", ["-c", 'rg missing . || printf "no matches"']],
    ["bash", ["-c", "printf '%s' '$(literal)' "]],
  ])
    assert(repeatableCommand(exe, args), JSON.stringify([exe, args]));
});
test("shell expansion, side-effect predicates and high-risk commands never gain repeat approval", () => {
  for (const [exe, args] of [
    ["find", [".", "-delete"]],
    ["find", [".", "-exec", "rm", "{}", ";"]],
    ["find", [".", "-fprintf", "output", "%p"]],
    ["rg", ["--pre=arbitrary-program", "x"]],
    ["git", ["-C", "project", "push"]],
    ["git", ["status", "-c", "alias.x=!arbitrary"]],
    ["npm", ["run", "deploy"]],
    ["rm", ["-rf", "target"]],
    ["python3", ["script.py"]],
    ["bash", ["script.sh"]],
    ["bash", ["-c", "ls; git push"]],
    ["bash", ["-c", "ls && git push"]],
    ["bash", ["-c", "ls | sh"]],
    ["bash", ["-c", 'printf "$(git push)"']],
    ["bash", ["-c", "printf `git push`"]],
    ["bash", ["-c", "ls > output"]],
    ["bash", ["-c", "ls &"]],
    ["bash", ["-c", "ls\nrm -rf target"]],
    ["bash", ["-c", "ls &&"]],
    ["bash", ["-c", "ls ||| cat"]],
    ["bash", ["-c", "ls 'unterminated"]],
    ["bash", ["-c", "ls $OPTIONS"]],
    ["bash", ["-c", "ls *"]],
    ["bash", ["-c", "NAME=value ls"]],
    ["bash", ["-c", "ls \\; rm file"]],
    ["bash", ["-c", "ls", "extra-argument"]],
  ])
    assert(!repeatableCommand(exe, args), JSON.stringify([exe, args]));
});
test("workspace programs and options that run, delete or overwrite elsewhere always ask", () => {
  for (const [exe, args] of [
    ["./tools/cat", ["notes.txt"]],
    [".venv/bin/pytest", []],
    ["/Users/someone/project/bin/ls", []],
    ["bash", ["-c", "./tools/cat notes.txt"]],
    ["rg", ["--hostname-bin=./tools/x", "TODO"]],
    ["rg", ["--hostname-bin", "./tools/x", "TODO"]],
    ["pytest", ["--basetemp=src"]],
    ["pytest", ["-o", "cache_dir=src", "--cache-clear"]],
    ["pytest", ["-ocache_dir=src"]],
    ["tsc", ["--outFile", "src/index.ts"]],
    ["eslint", ["-o", "src/index.ts", "."]],
    ["vitest", ["run", "--outputFile=src/index.ts"]],
  ])
    assert(!repeatableCommand(exe, args), JSON.stringify([exe, args]));
  for (const [exe, args] of [
    ["/usr/bin/git", ["status"]],
    ["/opt/homebrew/bin/rg", ["TODO", "src"]],
    ["pytest", ["-q", "tests"]],
    ["tsc", ["--noEmit"]],
    ["eslint", ["src"]],
    ["vitest", ["run"]],
  ])
    assert(repeatableCommand(exe, args), JSON.stringify([exe, args]));
});
test("shell grants retain the exact wrapper and full script, never a parsed command prefix", () => {
  const identity = (args) =>
    grant("command", { executable: "bash", args }, "exact command").id;
  assert.notEqual(identity(["-c", "ls"]), identity(["-lc", "ls"]));
  assert.notEqual(identity(["-c", "ls"]), identity(["-c", "ls -a"]));
  assert.notEqual(identity(["-c", "ls"]), identity(["-c", "ls && git push"]));
});

test("GitHub read commands and GET API calls support scoped approvals", () => {
  for (const args of [
    ["pr", "list"],
    ["pr", "view", "12", "--json", "title"],
    ["pr", "diff", "12"],
    ["repo", "view"],
    ["issue", "list", "--repo", "example/project"],
    ["run", "view", "123", "--log"],
    ["api", "repos/example/project/pulls"],
    ["api", "/repos/example/project/issues", "--method", "GET"],
    ["api", "search/issues?q=repo:example/project", "-XGET", "--jq", ".items"],
    ["api", "repos/{owner}/{repo}/pulls", "--paginate", "--slurp"],
  ])
    assert(repeatableCommand("gh", args), JSON.stringify(args));
  assert(repeatableCommand("bash", ["-lc", "gh pr list --limit 5"]));
});
test("GitHub mutations, credentials, GraphQL and implicit POST never acquire automatic grants", () => {
  for (const args of [
    ["pr", "create"],
    ["pr", "merge", "12"],
    ["pr", "comment", "12", "--body", "message"],
    ["release", "create", "tag"],
    ["repo", "delete", "example/project"],
    ["auth", "token"],
    ["pr", "view", "--web"],
    ["api", "graphql"],
    ["api", "repos/example/project/issues", "-f", "title=new"],
    ["api", "repos/example/project/issues", "--method", "POST"],
    ["api", "repos/example/project/issues", "--method=DELETE"],
    [
      "api",
      "repos/example/project/issues",
      "-X",
      "GET",
      "--input",
      "body.json",
    ],
    [
      "api",
      "repos/example/project/issues",
      "--header",
      "X-HTTP-Method-Override: DELETE",
    ],
    ["api", "https://example.org/path"],
    ["api", "//example.org/path"],
    ["api", "repos/example/project/issues", "--verbose"],
    ["api", "repos/example/project/issues", "--hostname", "example.org"],
  ])
    assert(!repeatableCommand("gh", args), JSON.stringify(args));
});
