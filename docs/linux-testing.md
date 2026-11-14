# Linux setup and testing

Install a supported Node LTS release and the distribution's bubblewrap, socat
and ripgrep packages. The host must allow the namespaces and seccomp operations
required by the sandbox runtime. Run `/doctor` to check prerequisites without
executing project code.

Use a disposable development VM or CI runner to test platform enforcement.
No GUI is needed for the automated suite; interactive IDE acceptance is separate.
Use generated fixtures and mock services rather than live credentials. Do not
mount host credential directories or forward an SSH agent into a test guest.

```sh
npm ci --ignore-scripts
npm run lint
npm run typecheck
npm test
npm run build
npm pack
```

Also install the tarball outside the checkout and run `test/package-install.mjs`
as described in [testing](verification.md). Record the OS, kernel, Node, npm,
bubblewrap and runtime versions with test results. Linux VM results do not
establish native Windows or every container runtime's support.

## Namespace failures

A denied namespace probe must remain a failure. Inspect distribution policy and,
inside containers, the outer runtime's seccomp/namespace restrictions. Do not
globally disable AppArmor, SELinux, seccomp or user-namespace restrictions.

Ubuntu may require an administrator-reviewed application-specific user-namespace
rule for root-owned `/usr/bin/bwrap`. The included [AppArmor profile](bwrap-apparmor.profile)
is used by disposable development CI runners. It is not installed by agent setup.
Validate syntax before loading any profile and preserve the global namespace
restriction. An existing `bwrap` profile can include child-transition restrictions;
replacing it changes those restrictions too and requires administrator review for
that exact host. Do not install competing executable attachments.

An exception approved for a VM or CI runner does not authorize changes to its
host or other machines. Follow [Ubuntu's per-application guidance](https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces)
and the host's administrative change process.

`test/policy-system.mjs` needs separately prepared root-owned policy fixtures.
`test/fixtures/linux-mount-repro.mjs` is a standalone mount diagnostic, not part
of normal application startup. Neither should be used to weaken enforcement.
