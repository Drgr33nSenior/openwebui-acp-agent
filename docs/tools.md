# Coding, MCP and Open WebUI-managed tools

The agent refreshes runtime-verification guidance from the tools offered in each
model request. When commands are available, it asks the model to run executable
entrypoints and relevant failure cases in addition to tests. When browser
navigation and snapshots are available on the same MCP server, it adds browser
and documentation guidance; interactive checks also require a click tool. Web
search guidance requires an enabled server-task catalog with that feature.
Plan and read-only modes omit execution guidance. This is model guidance, not a
guarantee of successful verification or additional permission.

## Definition of done

When `run_command` is offered, the guidance adds a definition of done: before
finishing, name the check that proves the change works (a test, a run of the
entrypoint or a play-through) and run it after the last edit. For a bug, first
run something that fails for the reported reason, then fix it and rerun the same
check; if it cannot be reproduced in two attempts, say so. The final message
lists each command run with its result, and what was not verified.

One reminder enforces this lightly. It is sent at most once per turn, through
the same continuation as a verification repair round, when all of these hold:

- the model replies without tool calls;
- a successful `write_file` or `edit_file` changed a file that can change
  behavior, and no `run_command`, `start_preview` or `browser_*` MCP call was
  attempted after it (a declined or failed call counts; one rejected for invalid
  arguments does not);
- `run_command` is offered, no project checks are configured for the workspace
  (those run automatically and count as the check), and a model round remains.

Prose and notice files do not trigger it: `.md`, `.markdown`, `.mdx`, `.txt`,
`.rst`, `.adoc`, `.asciidoc`, `.org`, and `LICENSE`, `NOTICE`, `AUTHORS`,
`CHANGELOG`, `CHANGES` and `COPYING` with any extension. `requirements*.txt`
and `CMakeLists.txt` do. The reminder names the files and is shown to the user;
if the model still does not run anything, the turn ends normally.

## Reading files

`read_file` returns numbered lines. Each line starts with its 1-based number and
`→`, which is not part of the file:

```text
1→import sys
2→
3→def main():
[lines 1–3 of 3; end of file]
```

A file up to 8 KB comes back whole. A larger file comes back 400 lines at a
time; the footer gives the range and the next offset, for example
`[lines 1–400 of 1210; continue with offset=401]`. Pass `offset` (the first
line, 1-based) and `limit` (at most 2,000 lines) to read another range:

```json
{ "path": "src/app.py", "offset": 401, "limit": 100 }
```

An offset past the last line is not an error: the result is the last page (the last `limit` lines, 400 by default) with a note before the footer, for example
`[offset 400 is past the end; the file has 351 lines; showing lines 1–351; lines 1–351 of 351; end of file]`.
An empty file keeps `[empty file: 0 lines]`. A page also
stops at about 24,000 characters, and a line longer than 2,000 characters is cut
with a marker giving its length. For a file with CRLF line endings, lines are
shown without the carriage return and the footer says so; a multi-line
`edit_file` `old_string` must still contain `\r\n`. The existing limits still
apply: files over 100,000 bytes and files containing NUL bytes are refused.

Four hundred lines is about 4,000 tokens of typical source and usually holds a
whole class or module section. SWE-agent found a 100-line viewer resolved more
issues than whole-file reads, but each further page costs a model round on a
local model, so the page is larger here.

## Listing and searching files

`list_files` lists workspace files. It honours `.gitignore` files at every
level and always skips generated environments, caches and build output, even
without a `.gitignore`: `.venv/`, `venv/`, `__pycache__/`, `.mypy_cache/`,
`.pytest_cache/`, `.ruff_cache/`, `.tox/`, `.nox/`, `dist/`, `build/`,
`target/`, `.gradle/` and `.DS_Store`. These are recreated by tools, can hold
thousands of files and are rarely what the model needs to read. A project rule
lists one again, for example `!build/` in `.gitignore`. `.git/`, `.idea/`,
`node_modules/` and secret files are hidden from all file tools and cannot be
listed or read.

A listing returns at most 500 entries and 16,000 bytes. A larger result shows
the shallowest entries first, so the project layout stays visible. A final line
counts the rest by directory, for example:

```text
[1834 more entries not shown, in src/ (1200), tests/ (634); pass `path` to list a subdirectory]
```

Pass `path`, a workspace-relative directory, to list only that subtree:

```json
{ "path": "src/components" }
```

The path gets the same checks as `read_file`: it must stay inside the
workspace, cannot be a symlink, and cannot be a sensitive directory. Ancestor
`.gitignore` files still apply inside it. A default-ignored directory named
explicitly, such as `.venv`, is listed; files excluded by a project `.gitignore`
stay hidden.

`search_text` finds literal, case-sensitive text (no regular expressions) in
every file `list_files` would return without its cap. It returns up to
`max_results` lines (default 50, at most 200) as `path:line: text`, in path
order. A matching line over 200 characters is shortened around the first match.
When more lines match, a final line counts them; counting stops at 1,000 matches
and then reports a lower bound:

```text
[13 more matches in 7 files not shown; narrow with path or glob, or search for longer text]
```

`path` limits the search to a subdirectory or a single file, with the same
checks as `list_files` (outside, sensitive, symlinked and missing paths fail as
before). A single named file is searched even when a default ignore such as
`build/` would hide it from a directory search, and `glob` does not filter it;
output is unchanged. `glob` filters file paths: a pattern without `/`, such as `*.py`
or `*.{ts,tsx}`, matches file names at any depth; one with `/`, such as
`src/**/*.ts`, matches the workspace-relative path.

```json
{ "text": "parse_config", "path": "src", "glob": "*.py" }
```

## Text-file edits

Use `edit_file` for small changes to an existing file:

```json
{
  "path": "src/example.py",
  "old_string": "return total - bonus",
  "new_string": "return total + bonus"
}
```

Read the file first. `old_string` must be nonempty and match exactly once,
including whitespace and line endings. Copy it from the file text without
`read_file`'s line-number prefixes. When an `old_string` that matches nothing
would match once every line's prefix is removed, the error says to remove them;
a `write_file` `before` that equals the file once prefixes are removed gets the
same answer. The agent does not strip them itself: a file line can start with
digits and an arrow, and a `new_string` mixes copied numbered lines with new
ones, so a silent rewrite could change text the model did not mean to change.
Zero or multiple matches return the count and ask for current text with enough
surrounding lines. Set `replace_all: true` only to replace every non-overlapping
occurrence. Replacement text is literal: `$&` and similar sequences have no
special meaning. The tool does not normalize CRLF or add a trailing newline. The
resulting file must fit within 100,000 characters.

The `edit_file` description carries one example call with `old_string` and
`new_string`. The `run_command` description shows `executable` holding only the
program, each argument as a separate `args` item, and an explicit `sh -c` for
shell syntax: the [edit comparison](edit-verification.md) recorded an exit 127
when a whole command line was sent as `executable`.

A whitespace-containing `executable`, such as `python3 -m unittest`, is refused
before any process starts: `executable must be the program only; use executable:
"python3", args: ["-m", "unittest"]. ... Nothing was run.` The suggestion comes
from a plain whitespace split and is never executed, because quoting could change
its meaning. An existing absolute path that contains a space is still allowed.

A call that omits a required argument and adds undeclared ones, such as
`edit_file` with `write_file`'s `before` and `after`, is rejected with those
field names. Nothing runs and no alias is applied.

Use `write_file` with `before: null` to create a file. For a deliberate whole-file
rewrite, supply the complete current text in `before` and replacement in `after`.
An existing file larger than 8 KB (8,192 bytes) is refused before approval:
`write_file replaces whole files; this file is N KB, so a full rewrite risks being
cut off by the output limit. Use edit_file for targeted changes ...`. Nothing is
written and no approval is requested. `write_file` sends the file twice (`before`
and `after`), so 8 KB is about 16 KB or 4-5k tokens, well inside the default
12,288-token reply. There is no opt-out: several `edit_file` calls can make any
change. New files and files up to 8 KB are unaffected. Build large files as a
small skeleton, then extend them through small `edit_file` calls. Both tools show the full proposed diff and use the same workspace rules,
approvals, checkpoints and undo support. A full undo history drops its oldest
checkpoints instead of refusing the edit (see
[checkpoints](sessions.md#checkpoints-and-instructions)). A file changed during
approval is not overwritten. When client file methods are available, edits
preserve unsaved editor content; client denial never causes a local write
fallback.

Both tools report the change as ACP `diff` content (absolute path, complete old
and new text, `oldText: null` for a new file) on the approval request and on the
completed tool call. They also send the file and first changed line as an ACP
`locations` entry so the client can open the place being edited. Locations are
display metadata and grant no access. How a client renders either is its own
choice.

File tools remain unavailable in Plan or read-only permission mode. Read-only
sandbox mode rejects their writes. Successful changes participate in automatic
[verification after edits](ide-diagnostics.md). A no-op does not create a
checkpoint or invalidate a cached project check.

The model receives small-edit guidance and an output-token budget only when
file tools are available. Explicit model metadata takes precedence over the
configurable [fallback budget](configuration.md#private-configuration).
This guidance does not change the server's output limit.

## Direct MCP

Configure MCP servers through the client's ACP `mcpServers` definitions or the
agent's private `mcp.json`. This is different from JetBrains `agent_servers`,
which registers the agent itself. The supported transports are stdio, Streamable
HTTP and SSE. Prefer Streamable HTTP for new servers.

Private `mcp.json` contains an array. HTTP/SSE entries use `type`, `name`, `url`
and `headersFrom`; stdio entries use `type`, `name`, `command`, `args` and
`envFrom`. The `*From` maps contain environment-variable names, not secret values:

```json
[
  {
    "type": "http",
    "name": "research",
    "url": "https://tools.example.org/mcp",
    "headersFrom": { "Authorization": "RESEARCH_MCP_AUTH" }
  }
]
```

Supply the complete header value through the named variable using a secret
manager. MCP authentication is independent of the Open WebUI key. Project
`.mcp.json`, hooks and environment files are not loaded automatically.

Workspace and server activation happen before startup. Approvals disclose the
command/destination and environment names. A connection grant does not approve
its tools. Local stdio runs in the selected command sandbox with a bounded,
explicit program read scope. HTTP/SSE tools execute outside that sandbox.
Local HTTP servers, including the IDE and browser, require approval for each
call except the narrowly matched IDE file-problems diagnostic. Confirmed YOLO
supplies startup/call approval automatically, including per-server
`alwaysApproveTools` decisions, unless administrator rules require approval.
It also removes the local stdio process sandbox; catalog filters and validation
remain enforced.

Catalog discovery uses the official MCP SDK. Names are namespaced, arguments are
validated against supported JSON Schema dialects, and output/cancellation are
bounded. Read-only annotations do not grant authority. A remote server can cause
effects even if the local connection is cancelled.

An optional per-server `options` object accepts exact `includeTools` and
`alwaysApproveTools` lists, `callTimeoutMs`, `maxOutputChars`, `maxFrameBytes`,
`stripImages` and `rejectFileOutput`. Unknown configuration fails closed. See
[the browser configuration](browser.md) for a complete example. Tool filtering
also excludes new tools until explicitly included. A configured output bound
truncates text with a marker; transport frame limits still reject oversized data.
For configured HTTP timeouts, a bounded health check can preserve a responsive
connection. The failed call is never retried.

Search, retrieval and memory use tools actually discovered on your server; the
agent does not invent endpoints or assume standard names. Memory writes and
other remote mutations require the applicable operation approval.

## JetBrains bridge

The client can supply its IDE MCP connection. For supported macOS IDE launchers
with the sole `stdioMcpServer` argument, a validated IDE descriptor maps to its
local SSE endpoint instead of launching another IDE process. The approval shows
the effective destination and project. Supplied authentication/project headers
are preserved without exposing their values.

This does not sandbox IDE tools. Terminal, build, run-configuration and
refactoring tools keep per-call approval outside confirmed YOLO. Only
`get_file_problems` from the recognized client-supplied bridge for the exact
workspace qualifies for automatic diagnostics. See [verification after edits](ide-diagnostics.md).

## Open WebUI-managed tasks

Enable **Open WebUI tools** in the session selector or use `/server-tools on`.
`/server-tools refresh` discovers features and tool IDs without inference;
`/server-tools off` disables delegation. This mode requires **Open WebUI 0.9.0
or newer** for its chat task status/stop endpoints and asynchronous response
format. Older versions are blocked before task creation. Newer versions are
allowed with response validation; compatibility with every release is not
guaranteed. Report failures with the Open WebUI version and redacted error.
Core coding and direct MCP do not require this mode.

The reported version must use `major.minor.patch`, optionally with a `v` prefix,
prerelease suffix or build metadata. The 0.9.0 prereleases precede the minimum;
unparseable versions cannot establish compatibility and are refused for this
mode. See the [endpoint evidence](design.md#server-task-minimum-version).

The model receives `openwebui_task` for web research, image generation, retrieval
and selected server-managed tools. Features depend on server configuration,
account permissions and model metadata. Missing private configuration is labeled
unverified; explicit disabled features are not offered. Advertised capability
alone does not prove that a tool executes successfully.

Approval covers the displayed task prompt, model, features, tool IDs, remote
scope and retained chat. Session or remembered grants cover any prompt with that
exact scope, including mutations and new chats. A change in scope, backend
version or catalog requires approval again. Development mode does not create
remote grants.
Confirmed YOLO approves tasks without a per-task decision while server tools
are enabled; it does not bypass Open WebUI’s own approvals or account policy.
`/permissions revoke-tools` revokes them; Ask each time, approval advice and
administrator rules still apply.

Open WebUI may execute multiple tools internally. These calls do **not** receive
individual ACP approval and are outside the local sandbox. Server tools may read
or mutate remote data or expose execution capabilities. Memory must be selected
explicitly. The agent does not offer the code interpreter or select a terminal.
If Open WebUI pauses for its own approval, use the linked chat; the agent does
not bypass that pause.

Each approved task creates and retains an Open WebUI chat with its explicit
prompt and results. Local project history is not copied automatically. Results
include chat/citation links and bounded previews of supported generated images.
This does not add image inputs, uploads or image editing. Delete retained chats
in Open WebUI when no longer needed.

Cancellation sends a best-effort chat stop request. It cannot undo effects or
guarantee a remote job stops. Unknown outcomes are recorded and never replayed.
Loading a session or changing models resets server tools to Off. Local round
limits do not constrain the server's internal tool loop.

If API-key endpoint restrictions are enabled, this integration also needs these
prefixes. Keep the trailing slash on `/api/v1/tools/`, which matches the
discovery request:

```text
/api/version,/api/config,/api/v1/tools/,/api/v1/chats,/api/tasks/chat,/api/v1/files
```

Preserve `/api/models` and `/api/chat/completions` and any other required entries.
These prefixes cover discovery, owned chat creation/results, task status/stop,
and generated-image content. They also cover other routes below those prefixes;
account permissions must still restrict access. No admin settings change is
performed by the agent.
