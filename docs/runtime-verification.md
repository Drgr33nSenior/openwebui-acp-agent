# Runtime verification: evidence and limits

Version 0.5.0 builds on released 0.4.1 (`374ed526`). It adds runtime
guidance and an approved static preview for browser checks. The preview is a new
agent-owned listener with an explicit file scope and lifetime. Command sandbox
rules, browser approvals, dependencies, reasoning defaults and server-tool
version gates remain unchanged.

## Source comparison

The upstream `sst/opencode` repository redirects to `anomalyco/opencode`.
Inspection used stable release **v2.3.0**, published 13 November 2026, commit
`a6b15d33daf6ab7d35569f6d711fdb630b9f04e7`. The release API's `latest` alias returned
the older maintenance release v1.19.5; the v2.3.0 tag and non-prerelease release
record were checked separately. Both projects use MIT. The new guidance is
original prose, not copied prompt text.

Relevant upstream behavior:

| Source at that commit                                     | Observation                                                                                           | Decision here                                                                                           |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `packages/core/src/session/runner/prompt/system.txt:1–17` | A short base prompt delegates to tools; it does not explicitly require playing a generated game.      | Do not attribute the owner's better game result to a verified run-it rule.                              |
| `packages/core/src/session/system-prompt.ts:5–27`         | Tool-specific instructions depend on the tools actually offered.                                      | Refresh runtime guidance each model round, after tool filtering; do not persist it in history.          |
| `packages/core/src/tool/todowrite.txt:1–7`                | Plans are encouraged for multi-step work and updated as work proceeds.                                | Retain the existing `update_plan` guidance and enforcement.                                             |
| `packages/core/src/tool/plugin/shell.ts:25–68`            | Foreground commands default to 120 seconds; background jobs return immediately and notify completion. | Use the existing bounded jobs, inspect readiness/output and stop owned processes. Retain finite limits. |
| `packages/core/src/tool/plugin/websearch.ts:20–22`        | The search tool explicitly supports current information.                                              | Add official-documentation guidance only when browser or server web-search tools are available.         |
| `packages/core/src/tool/plugin/webfetch.ts:80–90`         | Redirect handling checks the next URL's permission.                                                   | Do not equate an approved initial browser URL with confinement of all browser traffic.                  |
| `packages/core/src/session/runner/llm.ts:246–280`         | The loop refreshes context/tools, attempts compaction and handles configured step limits.             | Retain existing compaction, cancellation and finite model/tool budgets.                                 |
| `packages/core/src/session/runner/max-steps.ts:1–16`      | Limit exhaustion requests a summary of completed and unfinished work.                                 | Already implemented here; no budget increase in this change.                                            |

Plain-text source references (append the table's file and line range):

```text
https://github.com/anomalyco/opencode/releases/tag/v2.3.0
https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/LICENSE
https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/session/system-prompt.ts#L5-L27
https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/session/runner/prompt/system.txt#L1-L17
https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/tool/todowrite.txt#L1-L7
https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/tool/plugin/shell.ts#L25-L68
https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/tool/plugin/websearch.ts#L20-L22
https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/tool/plugin/webfetch.ts#L80-L90
https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/session/runner/llm.ts#L246-L280
https://github.com/anomalyco/opencode/blob/a6b15d33daf6ab7d35569f6d711fdb630b9f04e7/packages/core/src/session/runner/max-steps.ts#L1-L16
```

OpenCode was not installed on this Mac, so no live comparison was run. The
original better-game transcript was unavailable. These source observations are
candidate explanations, not proof of causation.

## Repeatable live tasks

`test/fixtures/runtime-tasks.json` fixes four prompts and their initial files:
a browser game, integer CLI with invalid input, regression-first bug fix, and a
current Node.js documentation question. Each uses a new scratch workspace and
isolated application state. The ordinary tests do not run these live tasks.

With the agent already signed in through its normal setup, explicitly run:

```sh
node test/manual-runtime-benchmark.mjs --live /path/to/installed/agent baseline
node test/manual-runtime-benchmark.mjs --live /path/to/built/checkout after
```

The runner uses the same configured inference destination/model and **Model
default** reasoning. It copies only named non-secret connection/limit settings
and the sign-in epoch, never credentials, transcripts, trust or project commands.
The child agent uses its normal OS credential-store flow. The parent does not
retrieve or export a key. Destination/model/home paths are redacted from reports.
Reports are private files under the printed scratch directory; retain or remove
that directory deliberately after reviewing it.

The runner supplies the documented browser at `127.0.0.1:8931/mcp`. It answers
ACP permissions once for scratch edits, static previews and sandboxed commands;
it refuses broader scope, unsandboxed execution and remote shell network requests. Browser calls
still pass through the normal tool filter and permission UI protocol. Navigation
is limited by this test client to high local ports or the specified Node.js
documentation page. This is a test policy, not a browser network sandbox: page
scripts, subresources and redirects remain subject to the container's existing
network access. Approval counts measure requests, not human response time.

Live runs on 14 November 2026 used macOS 27.0, Node 26.11.1, ACP SDK 2.6.0 and
Open WebUI 0.13.3 (public version endpoint checked). Browser versions were
`@playwright/mcp` 0.0.85 and Chromium revision 1254 in the existing local container.
Private model IDs and deployment addresses are intentionally omitted. The same
configured model was used throughout. No IDE UI was driven in these runs.

## Play-testing interactive apps

On 15 November 2026 the agent built a pygame platformer and ran 14 commands in
one turn. They were headless scripted play-throughs under SDL's dummy video
driver that asserted internal state. They passed while the real game was
unplayable, because the agent could not see the screen. `view_image` and the
[interactive-app rule](tools.md#interactive-apps) address this. The model must
look at what the app draws after real input, and say what it did not see.

opencode's current prompts only add emphatic verification wording. Plain-text
references (anomalyco/opencode, `packages/core/src/plugin/system-prompt/`):

```text
meta.txt: "Verify the correctness of your solution through execution whenever possible ... Evidence before synthesis."
kimi.txt: "test what you build, verify what you change"
```

The rule here is original prose. It adds what those lines lack: the evidence
for an interactive app is a viewed screenshot taken after real input.

A pygame play-test without a display:

1. Set `SDL_VIDEODRIVER=dummy` (and `SDL_AUDIODRIVER=dummy`) before importing
   pygame. Drawing, `pygame.image.save` and the event queue all work.
2. Run the game's own main loop. Do not reimplement it. Wrap
   `pygame.display.flip` (or `update`) to count frames, post input at chosen
   frames with `pygame.event.post`, save the display surface at key moments and
   post `QUIT` at the end.
3. Posted events do not change `pygame.key.get_pressed()`. If the game polls
   held keys, wrap `get_pressed` so that it also reports the keys the script holds.
4. Keep screenshots at most 1280×1280. Scale larger windows with
   `pygame.transform.smoothscale` before saving. Then call `view_image` on each
   screenshot and compare it with what a player should see.

```python
import os
os.environ.setdefault("SDL_VIDEODRIVER", "dummy")
os.environ.setdefault("SDL_AUDIODRIVER", "dummy")
import pygame
import game  # the real game; game.main() runs its own loop

held, frame = set(), 0
real_flip, real_pressed = pygame.display.flip, pygame.key.get_pressed

def flip():
    global frame
    real_flip()
    frame += 1
    if frame == 10:  # press and hold right
        held.add(pygame.K_RIGHT)
        pygame.event.post(pygame.event.Event(pygame.KEYDOWN, key=pygame.K_RIGHT))
    if frame in (5, 60):
        pygame.image.save(pygame.display.get_surface(), f"shots/frame{frame:03}.png")
    if frame == 61:
        pygame.event.post(pygame.event.Event(pygame.QUIT))

class Keys:
    def __init__(self, real):
        self.real = real
    def __getitem__(self, key):
        return key in held or self.real[key]

pygame.display.flip = flip
pygame.key.get_pressed = lambda: Keys(real_pressed())
game.main()
```

This recipe was run against a minimal 320×240 game that polls held keys, with
pygame-ce 2.5.8 and SDL 2.32.10 on macOS. The frame-5 screenshot showed the
player at the left. The frame-60 screenshot showed it moved right after the held
input. For web UIs, the browser tools drive clicks and keys but take no
screenshots. A rendering check needs a headless browser the project already
has, saving into the workspace, followed by `view_image`.

`test/manual-image-check.mjs --live AGENT_DIRECTORY` sends one 640×480
two-colour PNG through `view_image` and the real inference path, and prints what
the model said it saw. It authenticates like the runtime benchmark, except that
it copies only the named connection settings, not the sign-in epoch. It approves
only the scratch workspace activation and runs one turn: the `view_image` call
and the answer, two model requests.

## Changes and threat model

See [recorded runs and trimmed transcripts](runtime-verification-results.md) for
the baseline, intermediate repeat and final repeat. All runs ended with
`end_turn`; that protocol result does not mean every requested behavior was
verified. Those initial runs preceded static preview support. The follow-up
real-browser check passes with deterministic inference; live model retries
failed before coding with HTTP 503. See the results record for that distinction.

- With commands available: run the actual entrypoint, main behavior and meaningful
  bad-input/boundary case; inspect outcomes and recheck failures. Readback/static
  checks alone do not prove execution. Use workspace-relative paths.
- With bounded job tools available: start a background job, inspect readiness and
  failures, and stop it. A job ID does not prove reachability. A blocked listener
  is a reason to stop and ask, not switch execution routes.
- With navigation and snapshots on one discovered MCP server: inspect browser
  output and consult official documentation. Interaction guidance additionally
  requires a click tool. Host/container paths and loopback are distinct.
- With static preview tools also available: snapshot an explicit frontend file
  list, use the returned URL for the browser's topology, check interactions and
  stop the preview. Recreate the snapshot after edits. Framework servers and
  backend APIs are outside this tool's scope.
- Server search guidance requires an offered `openwebui_task` and a catalog that
  includes `web_search`. An image-only catalog does not enable search guidance.
- Clarify that `write_file.before` and `after` are full-file text, including the
  final newline. Both live coding runs exposed repeated search-fragment attempts.
  The stale-edit error now explains this contract; validation remains unchanged.

Only agent-owned prose enters the extra system message. MCP descriptions, names
and retrieved text cannot supply instructions or authorization. Catalog names
select fixed guidance, not grants. Filtered-out tools and Plan/read-only modes do
not receive execution guidance. Rebuilding each round also covers restored
sessions and prevents a stale browser catalog from becoming a persistent promise.

Browser calls still need their existing approval. A malicious local page or injected project
text can lure the model into navigating, submitting data or treating a tool as
read-only. An initial localhost URL does not constrain redirects, subresources,
forms or page scripts. Grouped snapshot grants also require a trusted server
identity and verified operation semantics; upstream read-only annotations alone
are insufficient. Downloads, arbitrary code, remote actions and per-call browser
approvals retain their existing restrictions.

The macOS command sandbox sets `allowLocalBinding: false`. The pinned runtime's
broader switch also opens localhost connections to other host services; enabling
it would weaken the existing boundary. Linux uses a separate network namespace.
The new preview avoids that switch: after approval, the agent serves only a
bounded immutable snapshot on one loopback port. It executes no workspace
program. Local processes can read those approved files; loopback is not
authentication. Host/Origin checks and a restrictive Content Security Policy
reduce exposure, but do not establish full browser navigation confinement.
Per-call browser approval remains required.

`test/preview-browser.mjs` exercises the ACP file-write → preview → real Chromium
interaction → shutdown path. The older direct browser fixture starts an external
host listener and does not cover that path. General application-server hosting,
Linux container routing and a complete browser-origin boundary remain separate
work. See [preview scope and limits](browser.md#starting-an-application-for-browser-checks).

Reasoning defaults, planning and job limits remain unchanged. The baseline already
ran CLI failure cases and regression tests and fetched current documentation;
there is no evidence here that low reasoning effort was the bottleneck. Model
guidance remains probabilistic. A single run per task is not a quality benchmark.
