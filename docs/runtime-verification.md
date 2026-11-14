# Runtime verification: evidence and limits

This unreleased harness change builds on released 0.4.1 (`374ed526`), rather than
the 0.4.0 baseline named in the task. No dependencies, default reasoning settings,
permission grants, sandbox policy or server-tool version gates change.

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
ACP permissions once for scratch edits and sandboxed commands; it refuses broader
scope, unsandboxed execution and remote shell network requests. Browser calls
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

## Changes and threat model

See [recorded runs and trimmed transcripts](runtime-verification-results.md) for
the baseline, intermediate repeat and final repeat. All runs ended with
`end_turn`; that protocol result does not mean every requested behavior was
verified. The game remains blocked from a real browser play-through.

- With commands available: run the actual entrypoint, main behavior and meaningful
  bad-input/boundary case; inspect outcomes and recheck failures. Readback/static
  checks alone do not prove execution. Use workspace-relative paths.
- With bounded job tools available: start a background job, inspect readiness and
  failures, and stop it. A job ID does not prove reachability. A blocked listener
  is a reason to stop and ask, not switch execution routes.
- With navigation and snapshots on one discovered MCP server: inspect browser
  output and consult official documentation. Interaction guidance additionally
  requires a click tool. Host/container paths and loopback are distinct.
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

**No permission relaxation was made.** A malicious local page or injected project
text can lure the model into navigating, submitting data or treating a tool as
read-only. An initial localhost URL does not constrain redirects, subresources,
forms or page scripts. Grouped snapshot grants also require a trusted server
identity and verified operation semantics; upstream read-only annotations alone
are insufficient. Downloads, arbitrary code, remote actions and per-call browser
approvals retain their existing restrictions.

The macOS command sandbox sets `allowLocalBinding: false`. The pinned runtime's
broader switch also opens localhost connections to other host services; enabling
it would weaken the existing boundary. Linux uses a separate network namespace.
An approved, narrowly scoped preview-hosting route and enforced browser-origin
boundary require separate design and boundary tests. The direct browser smoke
fixture uses an external host listener and does not demonstrate this missing
agent-launched path. See [browser hosting limits](browser.md#starting-an-application-for-browser-checks).

Reasoning defaults, planning and job limits remain unchanged. The baseline already
ran CLI failure cases and regression tests and fetched current documentation;
there is no evidence here that low reasoning effort was the bottleneck. Model
guidance remains probabilistic. A single run per task is not a quality benchmark.
