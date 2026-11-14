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

See [verification](../verification.md) and the
[live comparison](../edit-verification.md). These changes are not in 0.5.0.
