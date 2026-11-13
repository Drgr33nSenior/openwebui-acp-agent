import { SandboxError } from "./sandbox.js";

// SRT 0.0.83's profile grants securityd IPC for compatibility. Our agent stores
// its API key in Keychain, so the command boundary must deny that IPC explicitly.
// There is no public denyMachLookup option in this pinned release. Insert only
// at the exact shell-quoted profile header emitted by this version, never at
// arbitrary model command text. Any format change refuses execution.
export function protectMacKeychain(argv: string[]): string[] {
  const marker = " -p '(version 1)\n(deny default";
  const shell = argv[2] ?? "";
  const offset = shell.indexOf(marker);
  const ending = "' /bin/sh -c ";
  const end = shell.indexOf(ending, offset);
  if (
    argv.length !== 3 ||
    argv[0] !== "/bin/sh" ||
    argv[1] !== "-c" ||
    offset < 0 ||
    end < 0 ||
    shell.indexOf(marker, offset + 1) !== -1 ||
    shell.indexOf(ending, end + 1) !== -1 ||
    !shell.slice(0, offset).includes("/usr/bin/sandbox-exec")
  )
    throw new SandboxError(
      "Pinned macOS sandbox profile format changed; refusing execution",
    );
  const denies =
    '(deny mach-lookup (global-name-prefix "com.apple.security") (global-name "com.apple.SecurityServer"))';
  // Seatbelt's later matching rules take precedence: append after the runtime's
  // compatibility allows, inside the quoted policy, before the child shell.
  return [
    argv[0],
    argv[1],
    shell.slice(0, end) + "\n" + denies + "\n" + shell.slice(end),
  ];
}
