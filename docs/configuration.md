# Configuration and troubleshooting

## Private configuration

Non-secret configuration is `config.json` in the application directory:
`${XDG_CONFIG_HOME:-~/.config}/openwebui-acp-agent` on POSIX systems.
`OPENWEBUI_ACP_HOME` selects a different directory. Directories use mode 0700;
files use 0600. Native Windows persistence is disabled pending ACL support.

Setup writes `url` and `model`. Optional settings include:

| Setting                 | Default and range                                             |
| ----------------------- | ------------------------------------------------------------- |
| `header`                | `Authorization`; change only for a verified proxy requirement |
| `rounds`                | 40 model rounds per turn; maximum 100                         |
| `timeoutMs`             | 120000 ms for discovery; maximum 3600000                      |
| `firstContentTimeoutMs` | 900000 ms to first streamed content; maximum 3600000          |
| `idleTimeoutMs`         | 300000 ms between streamed chunks; maximum 3600000            |
| `verify`                | Bounded [verification settings](ide-diagnostics.md)           |

There is no overall turn deadline while content continues to stream. Stop remains
available. Each command has a separate `timeout_ms`: default 120000, maximum 600000. Existing explicit configuration values are preserved on setup.

Use `NODE_EXTRA_CA_CERTS` before launch for a private certificate authority.
TLS verification remains enabled, redirects are refused, and credentials cannot
appear in URLs. Project files cannot override credentials, policy or destinations.

## Authentication

Persistent credentials use the OS credential store. If it is unavailable, setup
fails rather than storing a plaintext key. A secret manager can explicitly
supply `OPENWEBUI_API_KEY` to the agent process instead. Do not put it in the
client's JSON configuration. The agent reads only named environment variables
and does not load project `.env` files.

`/logout` removes the saved key, records sign-out, invalidates tool grants and
cancels owned work. It retains transcripts and workspace trust. The sign-out
marker prevents an inherited environment key from silently signing back in.
After successful setup, an environment key takes precedence again: remove an
obsolete environment value before reconnecting. A failed secure-store deletion
is reported and leaves authenticated work blocked. Logout does not revoke the
key on Open WebUI or undo remote actions.

When model discovery returns 403, a restricted session keeps `/login`, `/logout`,
`/status` and `/doctor` available. It cannot activate workspace tools or MCP.
After repairing access, use `/doctor` and reconnect to resume coding.

## Failures

| Symptom                                      | Check                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 401 / authentication required                | API key validity, setup completion, inherited environment key, then reconnect                    |
| 403 / access denied                          | API-key permission and allowed endpoint prefixes on Open WebUI                                   |
| 404                                          | Installation path prefix, request method and selected model availability                         |
| 429                                          | Server rate limits and the reported retry interval                                               |
| 503 / model unavailable                      | Open WebUI and inference-provider availability; model discovery can work while inference fails   |
| TLS failure                                  | Certificate chain and explicit private CA configuration                                          |
| MCP catalog failure                          | Transport, server credentials, tool schema, sandbox dependencies and approved program read scope |
| Operation not permitted                      | [Filesystem scope and temporary files](sandbox.md), then ordinary OS permissions                 |
| Repeated approvals                           | Permission scope, local MCP execution, approval advice and administrator `alwaysAsk` rules       |
| Context indicator unchanged after compaction | It refreshes after the next response with usage counts; no estimated percentage is sent          |

A successful `/doctor` model-list request does not prove model inference works.
Use a short coding prompt to check inference. HTTP and tool failures are not
blindly retried because an operation might already have caused effects.

A cut-off or malformed model reply gets one corrective re-ask before any tools
from that reply execute. A second malformed response stops the turn. Tool errors
are redacted and returned to the model; a permission denial remains a denial.
Round or tool limits produce a progress summary. Inspect it before continuing;
completed actions must not be repeated without checking their state.

Saved-session workspace mismatches require the correct project. If an older
record lost its original path, the agent requests explicit approval to associate
its history with the current project. Decline if that history is not yours.
Do not edit trust records or delete history to bypass this check.

Malformed or symlinked state files fail closed. Stop clients before investigating
corruption or a stale lock. Preserve a backup; do not delete blocks merely to
make access succeed.

## CLI fallback

`openwebui-acp-agent` provides `acp`, `login`, `logout`, `models`, `status`,
`doctor`, `trust`, `trust revoke /absolute/workspace` and
`trust allow /absolute/workspace`. The last command explicitly clears a block
and remembers trust. Normal IDE use requires no wrapper script or routine CLI
login. Never pass credentials as arguments.
