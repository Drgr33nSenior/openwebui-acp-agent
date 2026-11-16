# Session controls

The IDE displays ACP session selectors when supported. Slash commands provide
fallbacks. Diagnostic commands do not make model inference requests.

| Command                                                  | Purpose                                                        |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| `/help`                                                  | List commands                                                  |
| `/status`, `/doctor`                                     | Inspect connection, model, tools, permissions and dependencies |
| `/login`, `/logout`                                      | Request IDE setup or sign out                                  |
| `/model MODEL_ID`, `/reasoning CHOICE`                   | Select discovered model and supported reasoning choice         |
| `/mode ask\|plan\|code\|yolo`                            | Choose the session mode                                        |
| `/permissions`                                           | Inspect permission mode, scopes and grants                     |
| `/permissions mode MODE_ID`                              | Choose an approval mode                                        |
| `/permissions sandbox workspace\|read_only\|full_access` | Choose OS isolation                                            |
| `/permissions revoke-tools`, `/permissions revoke`       | Revoke tool grants, or also block workspace access             |
| `/reviewer MODEL_ID`, `/reviewer off`                    | Enable or disable approval advice                              |
| `/plan on`, `/plan off`                                  | Switch between planning and coding                             |
| `/compact`, `/autocompact on\|off`                       | Compact context or change automatic compaction                 |
| `/queue on\|off\|steer`                                  | Queue, interrupt or steer with prompts sent while busy         |
| `/jobs`, `/jobs poll ID [OFFSET]`, `/jobs stop ID`       | Inspect, read or stop a background job                         |
| `/checkpoints`, `/checkpoints clear`, `/undo [ID]`       | Inspect edit history, clear it, or propose reversal            |
| `/rewind`, `/rewind TURN [--keep-files]`                 | List turns, or return to before a turn                         |
| `/sessions [CURSOR]`                                     | Browse saved sessions for this workspace/backend               |
| `/title [TEXT]`                                          | Set or clear the current session title                         |
| `/fork [TITLE]`                                          | Create a separate saved conversation                           |
| `/export PATH.md`, `/export PATH.json`                   | Propose an export into the workspace                           |
| `/server-tools on\|off\|refresh`                         | Control optional Open WebUI-managed tools                      |

## Session modes

The **Mode** selector (ACP category `mode`) is a view over existing controls.
It adds no separate permission system:

| Mode | Maps to                                              | Effect                                                                                 |
| ---- | ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Ask  | **Read only** permission mode, Code workflow         | File inspection only. No edits, commands, MCP processes/tools or server tasks          |
| Plan | Plan workflow; permission mode unchanged             | Inspection and plan updates. Edits, commands, MCP startup and server tasks are blocked |
| Code | Code workflow with the selected **Permissions** mode | Current behavior: approvals, Sandbox and administrator rules apply                     |
| YOLO | Code workflow, **YOLO — full access (session)** mode | Same as choosing YOLO in Permissions: confirmation at the next workspace prompt        |

Choosing Ask selects Read only and leaves YOLO. Choosing **Read only** in
Permissions also shows Ask, and choosing YOLO there shows YOLO. Returning to
Code from Ask or YOLO restores an earlier **Ask each time** or **Use scoped
approvals** choice from this connection; otherwise it selects the safe default.
It never restores edits, development or YOLO modes; select those again
explicitly. Plan keeps the Permissions value, so leaving Plan for YOLO keeps a
YOLO selection and its confirmation, while leaving it for Code exits YOLO.
Administrator `permissionModes` rules hide Ask without `read_only`, and hide
Code when neither `scoped` nor `ask` is allowed. YOLO is hidden and refused
unless both `yolo` and the `full_access` sandbox are allowed.

The YOLO mode follows [YOLO permissions](#yolo-permissions) exactly. Selecting
it is not consent: the mode shows **YOLO** as soon as it is selected, while
`/status` reports `yolo.confirmed: false` and commands stay sandboxed. The next
workspace prompt asks for confirmation before any model request or tool runs.
Declining or cancelling it returns to Code with the default approval mode. YOLO
is never saved, so a restored session shows Code.

Earlier releases gave the Permissions selector the ACP `mode` category, and
clients such as JetBrains remember the last value per category for new
sessions. The Mode selector and `session/set_mode` therefore also accept the
Permissions IDs: `yolo` selects YOLO (with confirmation), `read_only` selects
Ask, and `scoped`, `edits` or `development` select Code with that permission
mode, subject to administrator rules. `ask` keeps its Mode meaning (Ask). Other
values are rejected as invalid parameters.

The session file stores the workflow and non-elevated permission mode, so the
mode survives restore and fork. The model and reasoning choice are also saved per
session. `/status` reports `mode` and the available modes.

Clients that implement ACP v1 session modes, rather than config options, receive
the same modes in `modes`, can use `session/set_mode`, and receive
`current_mode_update`. Config-option clients receive `config_option_update`.
Both views stay in sync. The earlier `workflow` selector ID is still accepted
but no longer advertised. `/plan on|off` remains available.

## YOLO permissions

Choose the **YOLO** mode, **YOLO — full access (session)** in Permissions,
`/mode yolo` or `/permissions mode yolo`. The next workspace prompt asks for one
explicit confirmation after workspace activation.
A denied, invalid or cancelled reply returns to the administrator-compatible
default approval mode. No model inference or configured process starts while
that confirmation is pending. `/status` shows `yolo.confirmed`.

Confirmation skips routine approvals and selects unsandboxed commands/local
MCP for this session. Administrator rules and resource limits still apply.
Restore, fork, logout and revocation do not preserve confirmation. Use
`/permissions mode scoped` or the Code or Ask mode to exit; changing Sandbox or
enabling Approval advice also exits. Plan mode still blocks execution. See
[the access scope](../README.md#permissions).

## Models and context

The model selector lists the models Open WebUI returns for your account, with
display names where provided. The configured model is selected for new sessions.

Reasoning choices come from structured Open WebUI metadata, in the server's
declared order. Only declared levels are offered; Off (`none`) appears only when
the server declares it. If the only reasoning control declares a valid default,
new sessions and model changes select that level and send it explicitly.
Otherwise **Model default** is offered first and omits the override. Changing
models refreshes choices and selects the new model's default. Restoration keeps
a still-supported choice and otherwise uses the declared default. Metadata and HTTP
acceptance alone do not establish that a provider applies the selected control.

The context indicator uses the latest call's prompt tokens plus its visible
reply (text and tool calls) with the advertised full context window, falling
back to the input budget. Reasoning is left out: it is generated once and never
sent back, so it does not occupy the next request. The server's
`completion_tokens_details.reasoning_tokens` is used when reported; otherwise
the completion count is split by the characters received as reasoning and as
visible output. It does not sum billing totals or estimate missing counts.
Client rendering can retain an old value until the next usage update.

At the `xhigh` reasoning effort the agent sends `max_tokens` itself: the
`maxOutputTokens` the model list declares on the `xhigh` entry of
`supportedReasoningEfforts` (top level, then `openai`), else the advertised
`max_output_tokens`, else 32,768, and never more than half the advertised
`context_window`. Thinking counts against `max_tokens`, so a server that
allows a larger limit for that level declares it there. A server that leaves
that level uncapped would otherwise let one reply think until the window is
full. The same amount is reserved when requests are sized. Other levels send
no `max_tokens`, and a model without an advertised `context_window` gets none.
32,768 is a fixed figure, not a measured percentile of reply sizes. Without a
level-specific value, an explicit cap respects the advertised output limit even
if the server permits uncapped replies when the parameter is omitted. Reasoning
effort remains `xhigh`.

A reply cut off by the output limit before it produced any text or tool call
used the whole limit thinking. Asking for a shorter reply would not help, so
the single re-ask says so and runs once at the next lower declared level (by
the `reasoning_effort` order used for summaries; never Off), with that level's
own cap. Where no lower level is known it runs at the same level and asks for
briefer thinking. The session's selected level does not change.

### Clearing older tool results

Before compaction, the agent clears older tool results from what the model is
sent. The saved transcript keeps them. When the next request is estimated at
55% of the usable input, one batch runs:

1. Arguments of recorded `write_file` and `edit_file` calls outside the kept
   tail are elided: `before`, `after`, `content`, `old_string` and `new_string`
   values over 200 characters become
   `[elided from context: N chars; not file text; never copy this into a tool call; read the file to see it]`.
   A `write_file` or `edit_file` argument that starts with `[elided from context: `
   (including the wording of earlier releases) is refused before anything is
   written, with a pointer to `read_file`.
   The call, its path and its result (with the checkpoint ID) stay. A read that
   was repeated later with the same arguments is cleared.
2. Tool results are then cleared oldest first until the request is at about 30%:
   `[cleared from context: <tool> <arguments> returned N chars; re-run to see it again]`.
   Every call, its ID and its success or failure remain.

Never cleared: user and assistant messages; results of 600 characters or less;
failed or declined results up to 2,000 characters; the most recent tool results
(the latest two tool groups, and further back up to the lesser of 40,000 tokens
and 15% of the usable input); and the latest read of a file whose applied edit
is still in the uncleared part of the context. A batch that would reclaim less
than the lesser of 20,000 tokens and 10% of the usable input is skipped.

The boundary is saved with the session. Between batches the masked prompt does
not change, so a server prefix cache keeps working from round to round and
after a restart; each batch costs one full prompt evaluation. Masking needs the
model's advertised limits and one reported prompt count, like the pre-request
size check. `/doctor` output lists the boundary as `contextMask`. A write whose
argument is one of these placeholders is refused.

Images from `view_image` follow their own rule, independent of this boundary.
At most four stay in what the model is sent. A fifth clears all but the latest
two, again in one batch. Image bytes are never saved, so a restored session
sends stubs. See [viewing images](tools.md#viewing-images).

The task plan is not placed ahead of the conversation. The model sees it in its
own latest `update_plan` call. When that call is no longer in context (after
compaction or a restore without it), a short untrusted note after the latest
messages restates the plan. Nothing that changes during a turn precedes the
conversation, so a plan update leaves the prompt prefix intact.

Compaction is the next tier. It summarizes older completed history, as the
model was sent it, while keeping the original
transcript, leading instructions, recent request and complete tool groups.
Automatic compaction runs before inference at 80% of reported context capacity
or 700000 serialized characters when a safe older prefix exists. It also runs
when the next request would not fit the model's usable input: the advertised
`max_input_tokens`, or `context_window` minus the output allowance (the model's
`max_output_tokens`, else `outputTokenBudget`; at `xhigh`, the reply cap the
agent sends). The request is estimated from
its serialized size and the characters-per-token ratio of the server's latest
reported prompt count; without a reported count only the 80% rule applies.
Summarization uses the selected model with tools disabled, and the summary
request is held to the same input limit; see
[summary requests](#compaction-summary-requests).

A turn compacts at most three times. Failure or cancellation preserves context.
Failure notices state the reason: the request was refused (with its HTTP
status); the summary was empty, cut off at the output limit or over 16,000
characters; it did not reduce the context; no older history fits; or the session
could not be saved. Notices never quote the summary or history. When the next request still fits, an automatic failure warns once per turn and
the turn continues. When it would not fit and compaction fails, is switched off,
has reached the limit or has no complete older history left, the turn stops
before sending anything and says why; history and tool results are retained.
Summaries are untrusted text, not permission grants. Compaction cannot reduce an
indivisible oversized message. It does not shrink the saved transcript; see
[saved session size](#saved-session-size).

The same checks run before the single corrected-reply attempt after a malformed
or truncated response. That request is rebuilt from the current compaction
checkpoint, with current instructions, plan and available-tool guidance. It shares
the turn's three-compaction limit and stops if the input still cannot fit.
No tool from the discarded response executes.

A high-context notice appears at most once per turn, after the model's buffered
text has finished. It does not reset the context wheel: every valid provider
usage measurement still reaches the client. The wheel can stay full during
summarization until a subsequent coding response reports new usage. Recovery
messages distinguish output-limit truncation from malformed tool replies;
compaction cannot raise the model's output limit.

Plan mode allows inspection and structured progress updates. It blocks edits,
commands, MCP startup and server tasks. Plans persist through restore and
compaction without authorizing any operation.

### Compaction summary requests

A summary request does not use the session's reasoning level. An uncapped high
effort can spend the rest of the context window thinking and return no summary.
The request instead sends the lowest declared `reasoning_effort` level other than
`none`, ranked by the parameter's levels (`minimal`, `low`, `medium`, `high`,
`xhigh`, `max`), not by declaration order. When no declared level has a known
rank, as with named workspace controls, the server's declared default is used;
otherwise the model default. Thinking off is not chosen: summary quality without
reasoning has not been measured.

The request also sends `max_tokens`: 6,000, or the model's `max_output_tokens` or
`outputTokenBudget` when smaller. The cap bounds thinking and summary together on
servers that count both. The instruction asks for at most 12,000 characters (two
per capped token when the cap is smaller); summaries over 16,000 characters are
rejected. With a reported server token count, the summary input is held to 90%
of the usable input and of the context window minus the cap, so the input and
the capped reply fit together.
Manual `/compact` uses the same request and limits.

A summary cut off at the output limit, or over 16,000 characters, is retried once
with a smaller cut: at most half the input, so fewer older messages. This retry
belongs to the same compaction and does not count toward the per-turn limit.

## Incoming prompts

The default **Interrupt current turn** mode cancels active work, waits for cleanup,
and starts the latest waiting prompt. Partial assistant text and paired tool
results remain in history. Earlier waiting replacements return cancelled.

**Queue after current turn** processes delivered prompts in order, with at most
ten waiting messages. Each sees completed prior results and uses the normal
permissions. Stop cancels the active turn and all queued prompts. Logout and
disconnect discard waiting work; restore never restarts it. Individual request
cancellation removes that request. No Send now action is provided.

**Steer current turn** (`/queue steer`) adds a message sent while busy to the
running turn. It joins after the current model reply and any tool calls from
that reply finish, before the next model request. Messages join in arrival
order. A message that arrives during a final reply makes the turn continue.
If the turn ends first, for example at the round limit, or the running turn is
a slash command, the message runs as the next queued turn. Slash commands
never join a running turn. A joined message's request returns when that turn ends, with
the same stop reason. Cancelling only that request after it joined does not
remove it from history; Stop cancels the whole turn.

A joined message is stored with a short marker that tells the model it adds to
the running request. It joins before the next request is built, so the
pre-request size check and automatic compaction include it. When compaction
summarizes past it, the turn's original request stays pinned, and up to ten
joined messages after that request are kept verbatim beside it.

The client must allow sending overlapping prompts for queuing or steering to be
useful. The selector cannot add a send button to an IDE that only offers Stop
while busy. The selected mode persists, but pending messages do not.

### What current clients can express

ACP v1 has no steering or queue field. Both are proposals for ACP v2
(agent-client-protocol RFD PR 1261, "steer and queue prompts"), so the agent
selects behavior through this session option rather than per message.

| Client | Sending while busy | Use |
| --- | --- | --- |
| Zed (external agents) | Zed queues the message itself and sends it after the turn ends. **Send Now** stops the turn, then sends. Zed documents its steer toggle for its own agent only. | The default interrupt mode. Overlapping prompts do not arrive, so steer mode has no effect. |
| JetBrains AI Assistant / Air | Earlier testing found only Stop while a turn runs. The JetBrains ACP documentation does not describe queueing or steering. | No overlapping prompts arrive. Stop, then send. |
| Clients that send `session/prompt` while one is pending | Each request reaches the agent. | Choose queue or steer. |

Recheck this against the installed client version; it is not a compatibility
guarantee.

## Commands and background jobs

Command output appears as bounded, redacted tool-log updates before completion.
Background launches require explicit approval, even in development mode;
confirmed YOLO supplies session-wide approval instead.
There can be four running jobs and sixteen retained job results per session.
Each job stops at its timeout (at most ten minutes) and has a 100 KB output
limit; polling returns bounded pages. New network requests made while no turn
is active are refused rather than creating unattended approval requests.
Unsandboxed YOLO jobs do not use the network approval proxy.

A background job's tool call stays in progress while the job runs. About once
a second it shows the job state, run time, retained output size and the last
2,000 characters of output. When the job ends, the tool call becomes completed
(exit code 0) or failed (stopped, limited or nonzero). Clients that advertise the
ACP `session.notices` capability also receive a notice. At its next model
request, the model receives one short status line per finished job, so it does
not need to poll repeatedly. `poll_job` and `/jobs poll` still page the full
retained output. Clients might not show updates that arrive after a turn has
ended.

Jobs can continue after a successful turn. Stop, logout, disconnect, session
close, revocation and relevant permission/model changes stop owned jobs.
Interrupted turns also stop their jobs. Jobs and commands also end when the
agent process ends without a clean shutdown, for example when the client kills
it or it crashes. On macOS and Linux each unsandboxed command still leads its
own process group, and the agent also registers that group and its timeout with
one supervisor process, which it starts on first use. The supervisor kills each
group at its timeout and kills every registered group when its connection to the
agent closes, so neither depends on the agent still running. Registration
happens immediately after the command starts; an agent killed between those two
steps can still leave that one command running. If the supervisor itself stops,
the agent starts a new one with the next unsandboxed command and registers the
running commands again; until then, the agent's own timeouts and its exit and
crash cleanup of background jobs apply. A sandboxed command's broker stops it
when the agent's connection closes. Native Windows has no such lifecycle yet;
see the [Windows plan](windows-plan.md). Jobs are not restored or copied to forks.
Process cleanup cannot undo completed writes, external requests or detached
work on a remote server. A process that deliberately leaves its process group
and parent, such as a daemon that calls `setsid`, is not tracked.

## Checkpoints and instructions

Successful agent text edits record exact before/after content. `/undo` proposes
a diff and requests approval outside confirmed YOLO. It re-reads before applying
and refuses when later changes make the checkpoint stale. Undo covers agent file writes,
not shell commands, MCP actions, Git operations or remote tasks.

### Rewind

`/rewind` lists the session's user turns with a short excerpt and the number of
agent edits in each one. `/rewind N` discards turn N and every later message,
and restores files changed by agent edits in those turns. The next prompt
continues from the shortened history. Slash commands such as `/undo` count as
turns, as do joined steering messages.

Each affected file must still contain the agent's last edit. A file that
already matches its earlier content is skipped. If any file changed after the
agent's edit, or between two agent edits, nothing is restored and history is
unchanged. Review the file, or use `/rewind N --keep-files`, which only rewinds
the conversation. Files then stay as they are, and their checkpoints stay
available to `/undo`.

All restorations appear in one diff approval, unless YOLO is confirmed. Each
file is re-read before it is written. A file that changed during approval
stops the rewind. Restored files then match their earlier content, so a retry
skips them. A rewind cannot run while background jobs are running. Restoring
files follows the `/undo` rules: it is unavailable in Plan or read-only mode,
and removing a file the agent created is limited in the same way. Delete such
a file manually, then rewind again. Rewind clears the task plan and the context
indicator. It also drops a compaction summary that covered discarded messages.

Rewind restores only agent text edits recorded as checkpoints. It does not
revert commands, MCP or remote actions, Git operations, or edits made without a
checkpoint. Checkpoints created before this version have no turn information;
rewind leaves them for `/undo`. Your client may still show discarded messages
until you reopen the session from history. ACP v1 has no history-truncation
update. The rewind proposal in agent-client-protocol PR 1321 is an unmerged ACP
v2 draft, so this is a slash command.

Undo history keeps at most twenty checkpoints with a combined 2 MB content
budget. It never blocks an edit: when a new checkpoint would exceed either
limit, the oldest checkpoints are dropped first until it fits. At the end of
that turn one notice reports it, for example "Older undo checkpoints were
dropped to make room (2 removed); /undo and /rewind can no longer restore agent
edits from turn 4 or earlier." `/undo` then reaches only the remaining
checkpoints. `/rewind N` refuses to restore files when N is at or before the
latest turn whose edits lost a checkpoint (turn 4 here), because the restore
would be partial. `/rewind N --keep-files` still rewinds the conversation, and
`/rewind` lists which turns are affected. File text is limited to 100,000
characters, so every checkpoint fits the budget on its own. A checkpoint that
could not would be skipped: the edit is still made, the user is told once, and
`/undo` and `/rewind` cannot restore it.
`/checkpoints clear` discards only undo history, not files or transcripts.
Checkpoints containing configured credentials are refused. Creation undo needs
a safe delete operation: ACP editor filesystem methods do not provide one.
With those methods enabled, delete the file in the IDE after checking unsaved
content. Local creation undo is supported only on Linux and retains a recovery
copy; macOS requires manual deletion. Normal text replacement undo works through
the available client filesystem interface.

After activation, the agent reads bounded `AGENTS.md` guidance from the workspace
root through the target directory, up to sixteen levels and 64 KB in total.
Nested instructions apply to their subtree. Refreshed instructions are sent to
the model before a new edit proposal if they changed. Siblings and ancestors
outside the approved root are not loaded. Guidance cannot override permissions,
load hooks, or activate project executable configuration. `AGENTS.md` is the
only instruction file name loaded. Other agents' files, such as `CLAUDE.md`, and
project `skills/` or `.agents/skills/` directories are not loaded; the model can
read them with file tools when the guidance points to them.

## History, forks and deletion

Session listing uses backend/header and exact workspace scope. Titles are
explicit, not automatically extracted from potentially sensitive prompts.
Forks copy conversation, valid model settings, queue preference and plan state;
they reset broad execution modes and omit jobs, tool grants, checkpoints and
remote-task runtime state. Open a fork from the client's session history.
Export writes a proposed Markdown or JSON transcript after approval; confirmed
YOLO supplies that approval automatically.
Review exported content before sharing it.

Clients can open saved sessions through ACP `session/load`, which replays the
transcript, or `session/resume`, which restores it without replay. Replay
includes user and agent messages and each recorded tool call with its stored
result and outcome. Nothing is executed or approved again. Resume is for
clients that keep their own transcript. `session/close` stops a live session's
turns and jobs and frees its slot. It keeps the saved transcript.

Local `session-UUID.json` files retain transcripts, reasoning and bounded state.
Loading rechecks roots, consent and policy; executed tools never replay. Limits
include 32 live sessions, 1000 stored sessions, 8 MB and 10,000 messages per
saved session, and 256 MB aggregate storage. A session that outgrows its own
limit is trimmed as described below. Aggregate quota exhaustion stops work
rather than deleting other sessions. Stop the agent before deleting selected
transcript files. Keep configuration/trust files unless you intend to remove
those too. Known configured secrets are redacted, but arbitrary secrets in user
text or source files cannot be recognized reliably.

### Saved session size

The saved file keeps the full transcript, so long sessions grow even when
compaction keeps the model's context small. Saving never fails because one
session is too large. When the record would exceed 8 MB or 10,000 messages,
the agent trims the saved copy, oldest messages first, and stops as soon as it
fits:

1. Large tool results and tool-call arguments (over 4,000 bytes) in turns
   before the latest three become an excerpt: the first 1,200 and last 600
   characters around `[trimmed from the saved session: N bytes]`, where N is the
   original size. Arguments stay JSON with the same keys, so file paths, tool
   names, call IDs, result pairing and recorded success or failure are kept.
2. If that is not enough, older message text keeps only its first 160
   characters and the marker.
3. Then older turns are removed. The compaction summary, the request it pins
   with its steering messages, the system message and the AGENTS.md guidance
   message are kept, together with the latest three turns.
4. Only if the latest turns alone are too large are their results, then the
   older of those turns, reduced the same way. The current request is kept until
   nothing else remains.

Excerpts are cut from the already redacted text. The live conversation is not
changed: the model and `/rewind` keep using the full transcript until the
session is reopened. The first time a session is trimmed, a notice appears at
the end of that turn. Reopened history shows each trimmed entry with its
marker, and a resumed model sees the marker instead of the removed text.

File checkpoints are never trimmed. They must stay exact, and their own limit
(twenty checkpoints, 2 MB) leaves at least 5.8 MB of the 8 MB record for the
conversation. A reopened session therefore rewinds files from exact content. If whole turns
were removed, their numbers are gone: `/rewind` lists the remaining turns and
refuses others. Edits made in removed turns are no longer tied to a turn. Rewind
leaves them in place and reports them, and they remain available to `/undo`.
