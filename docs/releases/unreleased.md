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
- Advertise and implement stable ACP `session/resume` and `session/close`.
  `session/load` now replays recorded tool calls with their stored results and
  outcomes. It still never executes or approves them again.
- Add `/rewind` to return to an earlier turn. It restores the agent's own edits
  from the discarded turns through checkpoints, with one diff approval. It never
  overwrites later changes. `--keep-files` rewinds only the conversation.
- Add the **Steer current turn** prompt mode (`/queue steer`). A message sent
  while busy joins the running turn after its current tool step, or is queued
  if the turn ends first. It needs a client that sends prompts while busy.
- Show background job state, run time, output size and a bounded output tail in
  the job's tool call, with coalesced updates. When the client supports notices,
  send one on completion, and report finished jobs to the model once.
- Add a **Mode** selector (ACP category `mode`) with Ask, Plan and Code. Ask is
  the Read only permission mode, Plan is the existing planning workflow and Code
  keeps the selected Permissions mode. Modes never widen permissions; returning
  to Code does not restore edits, development or YOLO. The **Workflow**
  selector is replaced; its ID is still accepted. `/mode ask|plan|code` is the
  fallback.
- Return the same modes through ACP v1 `modes`, `session/set_mode` and
  `current_mode_update` for clients without session config options.
- Add **YOLO** to the Mode selector. It selects the existing YOLO permission
  mode with the Code workflow and still asks for confirmation at the next
  workspace prompt. It is hidden and refused when administrator rules disallow
  YOLO or full access. Choosing Code from YOLO exits it. The Mode selector and
  `session/set_mode` also accept Permissions IDs from earlier releases, which
  JetBrains replays onto new sessions: `yolo` selects YOLO, `read_only` Ask, and
  `scoped`, `edits` or `development` Code with that mode. This fixes the
  JetBrains warning "Mode: yolo (the agent rejected the value)" and the silent
  loss of the YOLO choice. Unknown values are rejected as invalid parameters.
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
- Send the edited file and first changed line as ACP `locations` with each file
  edit, next to the existing `diff` content.
- Name undeclared fields in argument errors when a required argument is missing,
  for example `edit_file` called with `write_file`'s `before` and `after`.
- Compact before a model request that would exceed the usable input (context
  window minus the output allowance, or the advertised input limit), not only at
  80% of reported usage. The summary request is held to the same limit and
  records verification status. A turn compacts at most three times; when a
  request still cannot fit, the turn stops with the reason instead of sending it.
  `/status` reports the context size and usable input as `contextLimits`.
- Apply the same compaction and input-budget checks to corrected-reply requests.
  Keep context notices out of buffered model text and show them once per turn.
  Explain output-limit truncation separately from malformed replies, while
  preserving the single-retry and three-compaction limits.
- Saving a session no longer fails with "Session storage budget exceeded". The
  per-session limit rises from 2 MB to 8 MB (10,000 messages; 256 MB in total).
  Beyond it, the oldest tool results and arguments in the saved copy become
  marked excerpts, then older turns are dropped. The live conversation,
  checkpoints, the compaction summary and the latest three turns are kept, and
  the user is told once. Large transcripts no longer block edits.
- `list_files` skips generated environments, caches and build output by default
  (`.venv`, `__pycache__`, `dist`, `build`, `target` and others; a `.gitignore`
  negation lists one again), returns at most 500 entries or 16 KB with a count of
  the rest, and accepts a `path` to list a subdirectory. `search_text` still
  searches every file.

See [verification](../verification.md), [session modes](../sessions.md#session-modes),
[ACP v2 readiness](../design.md#acp-v2-readiness) and the
[live comparison](../edit-verification.md). These changes are not in 0.5.0.
