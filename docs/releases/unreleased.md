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

See [verification](../verification.md) and the
[live comparison](../edit-verification.md). These changes are not in 0.5.0.
