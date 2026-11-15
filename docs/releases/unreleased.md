# Unreleased

No changes after [0.6.0](0.6.0.md).

- Raise the default `rounds` limit from 40 to 100 model rounds per turn and the
  maximum from 100 to 250. Context masking keeps long turns affordable, so
  multi-step tasks no longer stop early with "Model-round limit reached". The
  limit message and behavior at the limit are unchanged, and the 64 attempted
  tool-call budget is unchanged. Set `rounds` in the configuration to lower it.
- Recover from common tool misuse without a wasted round: `search_text` `path`
  may be a single file; `read_file` with an offset past the end returns the last
  page with a note; `run_command` refuses a command line in `executable` with a
  corrected `executable`/`args` suggestion before starting any process (an
  existing absolute path containing a space is still allowed).
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
- Undo history no longer blocks editing. When the twenty-checkpoint or byte
  budget is full, the oldest checkpoints are dropped to make room and one notice
  per turn says so. The byte budget rises from 500 KB to 2 MB. `/rewind` refuses
  to restore files for turns whose edits lost their checkpoints; `--keep-files`
  still works for them, and also no longer fails on an edit-chain gap.
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
- `write_file` refuses to rewrite an existing file larger than 8 KB before any
  approval, telling the model to use `edit_file`. Nothing is written. New files
  and files up to 8 KB are unaffected. This avoids a whole-file rewrite being
  cut off by the output limit mid tool call.
- Add `view_image` so the model can look at workspace screenshots: PNG, JPEG,
  GIF or WebP, up to 1 MB and 1280×1280. The image follows the tool results as
  a labelled user-role `image_url` message. Only the latest images stay in
  context; older ones become stubs in batches. Image bytes are never saved:
  stored and restored sessions keep the path, size and hash. `viewImage`
  (`auto`, `on`, `off`) controls the tool; `auto` respects Open WebUI's
  `vision: false` flag. Plan and read-only modes offer it as an inspection tool.
- For games, GUIs and web UIs, a definition of done that needs evidence: real
  input through the real event loop, screenshots viewed with `view_image`, and
  a final message saying what was seen. The once-per-turn check reminder also
  asks for a visual check when an interactive-app file changed after the last
  viewed screenshot. See the
  [pygame recipe](../runtime-verification.md#play-testing-interactive-apps).
- `write_file` takes `{path, content}`: the new file text only. The model no
  longer retypes the current file as `before`, which failed on large files with
  stale-edit and invalid-argument errors. The agent records a hash of each file
  as `read_file` last returned it (any page) or as it last wrote it, and replaces
  an existing file only when its current text still matches. An unread file or
  one changed since (editor, command, another process) is refused before
  approval with a "read it first" message. The 8 KB limit, approvals, diffs,
  checkpoints, undo and the after-approval recheck are unchanged. Records are
  saved with the session (hashed paths only), cleared by `/rewind` and not
  copied to forks. Older `{path, before, after}` calls still work: `after` is
  the content and `before` is ignored, with a note in the result.
- Elided write arguments now read `[elided from context: N chars; not file
text; never copy this into a tool call; read the file to see it]`; a copied
  placeholder is still refused, and the message points to `read_file`.
  `write_file` content made entirely of `read_file`-numbered lines is refused.
- `edit_file` on a missing file says to create it with `write_file`, and a
  write into a missing folder says so, instead of a raw `ENOENT` error.

See [verification](../verification.md), [session modes](../sessions.md#session-modes),
[ACP v2 readiness](../design.md#acp-v2-readiness) and the
[live comparison](../edit-verification.md). These changes are not in 0.5.0.
