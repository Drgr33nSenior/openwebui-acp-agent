# Verification after edits

After the model finishes a turn that used `write_file`, the agent checks up to
ten changed files using the connected JetBrains bridge. Errors return as compact,
deduplicated `path:line:column severity message` lines. The model gets at most
two repair rounds by default; remaining or incomplete checks are shown to the
user. A read-only turn does not trigger checks.

If the IntelliJ MCP server is absent, or a diagnostic call fails, times out or
returns a malformed result, verification falls back to the configured project
checks (if any) and says so. An absent server adds a line
`IDE diagnostics unavailable: no IntelliJ MCP server ...`; with no project
checks the result is "Verification incomplete" and starts no repair round. A
failed or timed-out file is reported as `IDE diagnostics unavailable or
malformed; no clean result established`. Neither case is treated as a pass.

## Enable the IntelliJ MCP server for the agent

1. In the IDE, enable the built-in MCP server (Settings | Tools | MCP Server)
   and approve the connection when the IDE asks.
2. Pass it to ACP agents. In AI Assistant, Agents settings, enable
   **Pass IntelliJ MCP server**. For a custom agent this is `use_idea_mcp` in
   `~/.jetbrains/acp.json` (default `false`); `idea_mcp_allowed_tools` can limit
   the exposed tools, and must include `get_file_problems`.
   See [JetBrains ACP documentation](https://www.jetbrains.com/help/ai-assistant/acp.html).
3. Start a new agent session in the project. The agent needs workspace trust
   and MCP connection approval for that workspace.

The agent recognizes the server only when the IDE supplied it through ACP with
the project path of the session workspace; a same-named tool from a
user-configured server is not used for verification.

## Tool names and source

The agent looks for the tool named `get_file_problems` whose input schema
matches the contract below exactly. The name and schema come from the IntelliJ
MCP server's `AnalysisToolset`
(`plugins/mcp-server/mcpserver.toolsets/src/general/AnalysisToolset.kt` in
`JetBrains/intellij-community`), which defines `get_file_problems(filePath,
errorsOnly, timeout)` and the batch `lint_files(files, min_severity, timeout)`.
The agent does not call `lint_files`: it needs its own allowlist entry, a
different result shape (`problems`, `more`, `notAnalyzedReason`) and would be a
new permission. Source checked 2026-11-14; no IDE was run for this change.

## Bounds

| Bound                 | Setting          | Default | Range      |
| --------------------- | ---------------- | ------- | ---------- |
| Edited files checked  | `maxFiles`       | 10      | 1-10       |
| IDE wait per file     | `ideTimeoutMs`   | 10000   | 1000-30000 |
| Reported IDE problems | `maxDiagnostics` | 50      | 1-500      |
| Total text characters | `maxOutputChars` | 8000    | 1000-16000 |

Only problems for the files the agent changed are requested, errors only unless
`includeWarnings` is set. `ideTimeoutMs` is sent to the IDE and also enforced by
the agent (plus two seconds). Omitted problems are counted in the result.

The bridge still needs workspace and connection approval. Only the exact
`get_file_problems` tool from the recognized client-supplied bridge for that
workspace receives the diagnostic exemption. Calls remain visible in the IDE
log. Administrator `alwaysAsk` and approval advice still require a decision.
An identically named tool on another server receives no exemption.
Terminal commands, builds, run configurations, refactoring and file writes are
never in this allowlist. Server read-only annotations are not authorization.

## Supported file-problems contract

The compatible JetBrains 2026.3 input schema is:

```json
{
  "type": "object",
  "properties": {
    "filePath": { "type": "string" },
    "errorsOnly": { "type": "boolean" },
    "timeout": { "type": "integer" },
    "projectPath": { "type": "string" }
  },
  "required": ["filePath"]
}
```

`filePath` is project-relative; `timeout` is in milliseconds. The agent supplies
the exact project path, errors-only selection and timeout. Results contain
`filePath`, an `errors` array with `severity`, `description`, `line`, `column`,
and optional `timedOut`. Locations are one-based. Structured content and JSON
text results are accepted. Source-line excerpts are not forwarded as extra
context. A timeout, malformed result or mismatched file never establishes a
clean check. Compatible schema discovery is required on other IDE versions.

The catalog can also expose `lint_files` with this input:

```json
{
  "type": "object",
  "properties": {
    "files": { "type": "array", "items": { "type": "string" } },
    "min_severity": { "type": "string" },
    "timeout": { "type": "integer" },
    "projectPath": { "type": "string" }
  },
  "required": ["files"]
}
```

It is not automatically allowlisted. No project-wide diagnostic tool is assumed.
IDE inspections are language-plugin dependent and do not establish full compiler
or test coverage.

## Project checks

Add `verify` to private `config.json`, preserving the existing fields:

```json
{
  "verify": {
    "maxFixRounds": 2,
    "includeWarnings": false,
    "maxFiles": 10,
    "maxOutputChars": 8000,
    "ideTimeoutMs": 10000,
    "maxDiagnostics": 50,
    "projects": [
      {
        "root": "/absolute/canonical/project",
        "commands": [
          { "executable": "npm", "args": ["test"], "timeout_ms": 120000 }
        ]
      }
    ]
  }
}
```

Commands are opt-in per exact root, with normal approval, network restrictions
and sandbox enforcement. A sibling worktree needs its own entry. Automatic
checks require an OS sandbox unless YOLO has been explicitly confirmed for
the session. In YOLO they run unsandboxed with the same limits and admin rules.
AGENTS.md commands remain guidance, not
executable configuration. Configure repeatable tests or linters: checks can run
again after a repair edit or command. Unchanged repair replies reuse the previous
project-check result; denied/unavailable checks are not retried in that turn.

`maxFixRounds` accepts 0–5; zero checks once without model repairs. `maxFiles`
accepts 1–10, `maxOutputChars` 1000–16000, `ideTimeoutMs` 1000–30000 and
`maxDiagnostics` 1–500. There can be four commands per
project, each with a default 120-second and maximum 600-second timeout.
Warnings are excluded unless configured. Checks share cancellation, the model
round limit and the 64-call turn budget.

Shell and MCP changes do not provide a complete changed-file journal; a turn
without an agent file write does not automatically start this verification loop.
Interruption retains completed results without replaying checks or leaving
unpaired tool calls.
