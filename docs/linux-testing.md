# Temporary Linux acceptance environment

The automated ACP and sandbox tests are headless. A GUI is only needed for later
interactive IDE acceptance. Test the Linux implementation in a disposable VM
before introducing a container's additional namespace and seccomp restrictions.

## Proposed development VM

- QEMU/KVM, run as the workstation user; no host root privileges.
- Ubuntu 24.04 LTS amd64 cloud image from
  [Ubuntu's image service](https://cloud-images.ubuntu.com/noble/current/).
  Resolve a dated build and verify its official SHA256 checksum before boot.
- Two virtual CPUs, 4 GiB RAM and a 16 GiB sparse writable disk.
- A new private directory containing the image, disk, cloud-init seed and logs.
- User-mode NAT; guest SSH forwarded to one unused host loopback port.
- A dedicated temporary SSH key, retained only on that host in the private
  directory. No host directories, credentials, SSH agent, GPU or devices shared.
- No changes to existing Kubernetes workloads, libvirt networks or host namespace
  policy. No privileged container, host package installation or GUI service.
- Guest-only installation of bubblewrap, socat, ripgrep, curl, a C compiler and
  the pinned Node version. All tests use generated fixtures and mock servers.

An operator must confirm the target VM as a development resource before remote
creation. Stop only the VM process owned by this test. Keep the disk and logs
until results have been reviewed; deletion is a separate explicit action.

## Checks inside the VM

Record the OS release, kernel, Node, npm and bubblewrap versions. From a copy of
the source, run:

```sh
npm ci --ignore-scripts
npm run lint
npm run typecheck
npm test
npm run build
npm pack
```

The suite exercises real namespace, filesystem, network, process and cancellation
boundaries. A mock runner cannot establish Linux isolation. Also install the
packed package outside the checkout and verify a clean ACP handshake. No real
Open WebUI key or workstation MCP credential is required.

The IDE's `/doctor` command runs a bounded namespace probe on Linux. A successful
probe establishes that bubblewrap can start the requested namespaces; it does
not replace the enforcement tests. A denied probe must remain a failure.

If namespace creation fails, inspect the distribution's kernel and application
security policy. In containers, also inspect the outer runtime's seccomp and
namespace restrictions. Do not globally disable AppArmor, SELinux, seccomp or
user-namespace restrictions to make a test pass. Bubblewrap requires host support
for [unprivileged user namespaces](https://github.com/containers/bubblewrap).

Native Windows remains a separate implementation sprint. Testing a Linux VM on
a Windows host does not establish native Windows support.

## Observed Ubuntu prerequisite

The tested Ubuntu 24.04.5 image blocked bubblewrap under its
`unprivileged_userns` AppArmor profile. An administrator-approved, guest-only
[application profile](bwrap-apparmor.profile) resolved that denial. Its syntax was
checked with `apparmor_parser --skip-kernel-load --skip-read-cache` before loading.
`kernel.apparmor_restrict_unprivileged_userns` remained `1`. This follows
[Ubuntu’s per-application guidance](https://ubuntu.com/blog/ubuntu-23-10-restricted-unprivileged-user-namespaces).
The agent does not install this rule automatically. CI runners may need an
administrator-provisioned equivalent; an unobserved CI definition is not a pass.
