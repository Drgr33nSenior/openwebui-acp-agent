# Testing and compatibility

## Automated checks

Use the pinned Node release from `.node-version` and a private temporary
`OPENWEBUI_ACP_HOME` set before starting Node. Tests create their own isolated
state and fake Open WebUI/MCP services. No real API key or deployment is required.

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm pack
npx --no-install prettier --check src test package.json package-lock.json registry/agent.json
npm audit --omit=dev --audit-level=high
```

`npm test` builds before running `test/*.test.mjs`. For a focused test, build first
and use `node --test test/NAME.test.mjs`. Real sandbox tests need local listener
and process permissions; outer sandboxes can prevent those checks from running.
Do not replace enforcement failures with silent skips.

Install the packed artifact into a fresh prefix outside the checkout. For a
public release, first download the `.tgz` and verify it against `SHA256SUMS` from
GitHub Releases:

```sh
npm install --prefix /path/to/isolated-install --ignore-scripts ./openwebui-acp-agent-0.4.0.tgz
npm audit --prefix /path/to/isolated-install --omit=dev --audit-level=high
node test/package-install.mjs /path/to/isolated-install
```

The installed-package check covers ACP stdout/handshake, terminal authentication
and logout discovery, context reporting and real command isolation. Dependency
compatibility must also hold in the installed bundled runtime tree.

The suite covers protocol/authentication, stream parsing, tool validation,
permissions, workspace boundaries, redaction, MCP, commands, queue/interruption,
verification repair limits, compaction, jobs, checkpoints, scoped instructions
and session listing/fork/export. Browser wrapper tests and the optional container
fixture smoke are described in [browser setup](browser.md).

## Compatibility

| Component                            | Scope                                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Node                                 | 26.11.1 test baseline; package accepts supported Node 24 and 26                                      |
| ACP                                  | Stable v1 through SDK 2.6.0; optional UI depends on client capability                                |
| MCP                                  | SDK 1.32.2; stdio, Streamable HTTP and SSE                                                           |
| macOS                                | Real filesystem/network/process boundary tests; Keychain credentials                                 |
| Linux                                | Bubblewrap/namespaces/seccomp; CI targets Ubuntu 24.04 and 26.04                                     |
| Native Windows                       | Unsupported; persistent state fails closed pending ACL/execution support                             |
| WSL2                                 | Linux route; requires separate environment acceptance                                                |
| JetBrains AI Assistant / Air in IDEs | ACP integration; product-specific UI and registry acceptance must be checked on the installed client |
| Open WebUI                           | Core contract based on 0.12.5 and 0.13.3; optional native server tasks gated to 0.13.3               |

CI checks macOS and Linux suites, Windows rejection behavior and separately
installed packages. A configured workflow is not a test result. Consult the
source PR's checks for the exact revision; skipped platform tests do not establish
support. Standalone Air is not interchangeable with Air in JetBrains IDEs.

Manual acceptance must cover a real backend, secure-store setup, IDE controls
and registry installation. Automated mocks cannot prove provider tool calling,
reasoning effects, editor rendering or all language-plugin diagnostics. See
[the release checklist](release.md). Test results belong with the source revision
and CI run, not a claim of compatibility for future versions.
