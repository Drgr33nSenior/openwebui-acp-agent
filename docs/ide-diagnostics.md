# Verification after edits

After the model finishes a turn that used `write_file`, the agent checks up to
ten changed files using the connected JetBrains bridge. Errors return as compact,
deduplicated `path:line:column severity message` lines. The model gets at most
two repair rounds by default; remaining or incomplete checks are shown to the
user. A read-only turn does not trigger checks. If the IDE bridge is absent,
IDE verification is skipped silently.

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
accepts 1–10 and `maxOutputChars` 1000–16000. There can be four commands per
project, each with a default 120-second and maximum 600-second timeout.
Warnings are excluded unless configured. Checks share cancellation, the model
round limit and the 64-call turn budget.

Shell and MCP changes do not provide a complete changed-file journal; a turn
without an agent file write does not automatically start this verification loop.
Interruption retains completed results without replaying checks or leaving
unpaired tool calls.
