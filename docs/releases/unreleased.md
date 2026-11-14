# Unreleased

- Add `edit_file` for unique literal replacements in existing files, with explicit
  `replace_all`, full-diff approvals, checkpoints, undo and automatic verification.
  It shares the protected write path with `write_file`.
- Guide the model toward small edits and reserve `write_file` for creation or
  deliberate full replacement. Large files can start as skeletons and grow through
  small edits. Guidance follows the session's available tools.
- Return concise field-specific validation errors, including missing command
  justifications and oversized inline arguments. Permission denials stay distinct.
- Use reported output allowances, or configurable `outputTokenBudget` guidance
  (default 12,288), to discourage oversized replies. Truncated tool replies get
  one re-ask for smaller changes. Server limits and default round limits are unchanged.
- Recheck scoped project instructions after file approval, before writing.
- Add a **Mode** selector (ACP category `mode`) with Ask, Plan and Code. Ask is
  the Read only permission mode, Plan is the existing planning workflow and Code
  keeps the selected Permissions mode. Modes never widen permissions; returning
  to Code does not restore edits, development or YOLO. The **Workflow**
  selector is replaced; its ID is still accepted. `/mode ask|plan|code` is the
  fallback.
- Return the same modes through ACP v1 `modes`, `session/set_mode` and
  `current_mode_update` for clients without session config options.
- Start the reasoning selector on the server's declared default level and send
  it explicitly. **Model default** remains only when no default is declared.
  Levels keep the server's order; Off appears only when declared.
- Show Open WebUI model display names in the model selector.
- Document ACP v2 readiness: client `fs/*` is optional with local fallback and
  `terminal/*` is unused. Other v2 shapes are deferred while the project
  targets stable ACP v1.
- Verification reports when the IntelliJ MCP server is absent instead of skipping
  silently, adds `verify.ideTimeoutMs` (enforced client-side) and
  `verify.maxDiagnostics`, and documents enabling the server for the agent in
  [IDE diagnostics](../ide-diagnostics.md). No new permissions.

See [verification](../verification.md), [session modes](../sessions.md#session-modes),
[ACP v2 readiness](../design.md#acp-v2-readiness) and the
[live comparison](../edit-verification.md). These changes are not in 0.5.0.
