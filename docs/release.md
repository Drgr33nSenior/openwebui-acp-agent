# Release and registry checklist

The MIT license is selected for this original implementation. The SVG is original
and uses `currentColor`; no Open WebUI artwork or source is distributed. The
source-preview target is the existing public
[Drgr33nSenior/openwebui-acp-agent repository](https://github.com/Drgr33nSenior/openwebui-acp-agent).
The user requested publication on 13 November 2026. The authenticated GitHub
account and repository owner were both verified as `Drgr33nSenior`. The npm name
still returned 404, which is not a reservation. No npm package or registry entry
has been published; the dependency advisory blocks package release.

Before distribution:

- Resolve engineering limits in design.md and complete the missing test cases in verification.md.
- Verify OS credential-store login/cancellation/logout and Windows ACL behavior, or restrict the published platform support explicitly.
- Review dependency advisories. Version 0.3.0 retains an unresolved high runtime/Zod advisory. The CI audit gate must remain failing until a reviewed compatible fix is available; do not suppress it or force an unsupported major override.
- Maintainer, repository, documentation and license URLs are populated from the
  verified GitHub repository. Check the public links after the initial push.
- Keep source-preview publication separate from package release. Verify the
  active `gh` account is Drgr33nSenior before GitHub operations.
- Recheck package-name availability, publish an immutable version, then validate its downloadable artifact.
- Run upstream registry schema, icon, packaging and authentication checks without weakening them. A local schema pass does not validate the existence of the package URL.
- Resolve the hosted Ubuntu sandbox failures before claiming CI qualification.
  The initial run denied nested user-namespace setup in the runtime's seccomp
  helper. Keep those failures visible; do not disable sandbox enforcement or
  tests. Platform jobs now run independently rather than cancelling on the first
  failure. Earlier disposable-VM passes do not establish hosted-runner support.

The latest upstream sandbox runtime remains 0.0.83 with Zod `^3.25.0`.
`npm audit --omit=dev` reports
[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), a high
memory-exhaustion vulnerability. No compatible upstream fix was available in
this check. npm publication authentication is also absent on this workstation;
complete npm authentication locally when a cleared release is ready. Do not
send tokens through chat or commit them.

The current registry JSON Schema and upstream manifest/version/icon functions
pass. The unmodified distribution-URL check correctly fails because the npm
package does not exist. Public-package authentication/installation checks remain
blocked by that absence. The upstream verification script was inspected but not
run against a nonexistent package; local installed-package authentication is
tested separately. No check was disabled to report a registry pass.

## Isolated JetBrains registry acceptance

Create an isolated development profile for each client. Record exact IDE, AI Assistant/Air client/plugin, agent, Node and backend versions. Disable the companion plugin in that profile only. Record the existing registry override before any change.

Investigate `llm.chat.agent.acp.external.registry.url` independently in the actual AI Assistant and Air client builds. A bounded local JAR search did not establish this setting in either inspected installation; do not assume the earlier workstation finding still applies. Air standalone and Air in IDEs are different client distributions. No normal profile was modified.

If the client supports an external catalog override, serve an isolated test registry with the real built package artifact. An override replaces the catalog; it is not additive. Record and restore its previous value. Do not use internal `agentsCatalogProvider` extension points. Follow the client's supported mechanism rather than inventing a registry format or setting.

Test registry installation separately from a manual `agent_servers` launch. Verify terminal auth under the actual client invocation. Do not claim registry acceptance while the artifact is unpublished or client interaction is unavailable.

## Manual acceptance record

For both AI Assistant and Air, record pass/fail, versions and evidence for: launch without the helper; masked first setup; real model selection/inference; unfamiliar-workspace approval; decline with no side effects; session-only and exact remembered scopes; approved diff/edit; approved command; cancellation; direct MCP search/retrieval/memory where available; independent Air worktree consent; useful diagnostics; history restore without replay; isolated registry installation. Verify reasoning controls against observed provider behavior, not HTTP status alone.

The user reports successful PyCharm authentication and messaging. The full checklist above, including rendering and enforcement of both remembered tool-approval choices, still requires recorded interactive acceptance. Do not retire the original solution until successful replacement acceptance and separate user authorization.

## Sandbox acceptance before broader testing

- Resolve or explicitly review the upstream runtime/Zod advisory; keep the normal
  audit job enabled. Do not present the current local package as a cleared release.
- Run the real boundary tests on macOS and Linux/WSL targets. Record OS, kernel,
  Node, runtime, bubblewrap and seccomp-helper versions. A compile pass is not
  platform acceptance. Do not disable namespace/security controls to pass tests.
- Keep native Windows disabled until storage ACLs, privileged sandbox setup and
  process cleanup have an implemented, independently tested lifecycle.
- Verify the Sandbox selector in AI Assistant and Air, network host/port choices,
  cancelled approvals, path exceptions, unsandboxed warnings and restore/revoke.
- Test an actual worktree, project build, authenticated GitHub read and direct MCP
  tool under the selected policy. Keep remote mutation approval separate.
- Review the pinned macOS profile adapter on every runtime update. Confirm the
  credential-service lookup is denied and normal HTTPS remains verified.
- Review the full Codex difference table. Advisory review and local administrator
  rules are implemented. Automatic model approvals, central enterprise management
  and native Windows remain deferred; do not advertise comprehensive parity.
