// SPDX-License-Identifier: Apache-2.0

/**
 * Credential PROVISIONING — credentials an auth needs that the person
 * connecting should never produce by hand. For SSH, the key pair: a pasted key
 * is usually a PERSONAL one installed elsewhere; a minted pair is used nowhere
 * else and never displayed. The host key is asked for, not scanned — a first
 * unauthenticated contact is exactly what a machine-in-the-middle answers.
 *
 * Which auths are provisioned, and what each mints, is the code table
 * {@link PROVISIONING}, keyed by package id and auth key — never the manifest.
 *
 * Invariants, stated here once:
 * - SYSTEM PACKAGES ONLY: provisioning has the platform mint a key and author a
 *   block pasted as root. The table names system package ids, and
 *   {@link readProvisioning} answers only for a package the platform loaded as
 *   a system package, so an org row that happens to carry the id is never
 *   provisioned.
 * - NO DOOR LETS A CLIENT SUPPLY `private_key`: the hosted form never renders
 *   it, the portal overwrites it, and `POST .../connect/fields` (no
 *   provisioner) refuses a minted name.
 * - THE HANDOFF IS DERIVED FROM THE STORED BUNDLE, NEVER STORED: creation and
 *   deletion screens both call {@link handoffStepsFor}, so they cannot drift.
 * - THE STORED BUNDLE IS UNTRUSTED AT RENDER TIME: everything interpolated into
 *   a pasted block is validated or rebuilt, never echoed.
 *
 * The fields the user DOES supply are bounded by the manifest's
 * `credentials.schema`, validated by `FieldsStrategy` on both doors.
 */

import { invalidRequest } from "../../lib/errors.ts";
import {
  fingerprintPublicKey,
  generateOpenSshEd25519PrivateKey,
  parsePublicKeyLine,
  publicKeyFromOpenSshPrivateKey,
  type PublicKeyType,
} from "../../lib/openssh-key.ts";
import { isBlockedHost } from "@appstrate/afps-shared/ssrf";
import { isSystemPackage } from "../system-packages.ts";

/**
 * One thing the user does or checks once the platform minted its half — data,
 * so a new kind needs no front-end branch. `id` is stable per kind (the SPA's
 * translation key); `label`/`note` are the English default.
 */
export type HandoffStep =
  | {
      kind: "command";
      id: string;
      label: string;
      /** Shell to run on the target. Copied, never executed by the platform. */
      shell: string;
      note?: string;
      /** Due at deletion, not now: the platform cannot reach the target to undo anything. */
      deferred?: boolean;
    }
  | { kind: "value"; id: string; label: string; value: string; note?: string };

type SubmittedFields = Record<string, unknown>;

function requiredString(fields: SubmittedFields, name: string): string {
  const raw = fields[name];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "") throw invalidRequest(`\`${name}\` is required`);
  return value;
}

/** Enumerated, not derived: the path is interpolated into a root script. */
const HOST_KEY_PUB_FILE: Record<PublicKeyType, string> = {
  "ssh-ed25519": "/etc/ssh/ssh_host_ed25519_key.pub",
  "ssh-rsa": "/etc/ssh/ssh_host_rsa_key.pub",
};

function hostKeyPubFile(hostKey: string): string {
  const parsed = parsePublicKeyLine(hostKey);
  if (!parsed) {
    throw invalidRequest("`host_key` must be a `ssh-ed25519 <base64>` or `ssh-rsa <base64>` line");
  }
  return HOST_KEY_PUB_FILE[parsed.type];
}

/** The base64 field of an `authorized_keys` line — unique per key, and `grep -F`-safe. */
function publicKeyBase64(publicKey: string): string {
  return publicKey.trim().split(/\s+/)[1] ?? "";
}

/**
 * The block that authorises the minted key on the named account. Filesystem
 * work goes through `su` AS the account: root following a swapped
 * `authorized_keys` symlink would write wherever it points. No `command=`: the
 * operator narrows the ACCOUNT. Every interpolation is validated and the `su`
 * payload is a QUOTED heredoc. The subshell keeps `set -eu`/`exit` from
 * outliving a paste into an interactive root shell.
 */
function renderInstallCommand(user: string, publicKey: string, hostKeyPub: string): string {
  return [
    `# Paste as root (or with sudo) on the target.`,
    `(`,
    `set -eu`,
    ``,
    `# The key line this block writes starts with restrict, which an sshd older`,
    `# than OpenSSH 7.2 rejects: installed, it would never work. Refuse first.`,
    `# A version that cannot be read (no sshd found, not OpenSSH) is only warned on.`,
    `# The output decides, never the exit status: an sshd that rejects -V exits`,
    `# non-zero, and under an inherited pipefail that would blank the version.`,
    `sshd=$(command -v sshd 2>/dev/null) || sshd=/usr/sbin/sshd`,
    `v=$("$sshd" -V 2>&1 | grep -o 'OpenSSH_[0-9][0-9.]*' | head -1) || :`,
    `v=\${v#OpenSSH_}`,
    `case "$v" in`,
    `  [0-9]*.[0-9]*)`,
    `    major=\${v%%.*}`,
    `    minor=\${v#*.}`,
    `    minor=\${minor%%[!0-9]*}`,
    `    if [ "$major" -lt 7 ] || { [ "$major" -eq 7 ] && [ "$minor" -lt 2 ]; }; then`,
    `      echo "appstrate: OpenSSH $v is older than 7.2: its sshd rejects the 'restrict'" >&2`,
    `      echo "  key option this connection relies on. Upgrade sshd, then run this again." >&2`,
    `      exit 1`,
    `    fi ;;`,
    `  *)`,
    `    echo "appstrate: WARNING: could not read the OpenSSH version of $sshd; this key needs OpenSSH 7.2 or later." >&2 ;;`,
    `esac`,
    ``,
    `# sshd runs a command through the account's LOGIN SHELL, so an account set`,
    `# to nologin runs nothing — and it would only surface mid-run, as a command`,
    `# that produced no output. Refuse here instead.`,
    `login_shell=$(getent passwd ${user} 2>/dev/null | cut -d: -f7) || :`,
    `[ -n "\${login_shell:-}" ] || login_shell=$(awk -F: -v u=${user} '$1==u{print $7}' /etc/passwd)`,
    `case "\${login_shell:-}" in`,
    `  */nologin|*/false)`,
    `    echo "appstrate: the login shell of ${user} is \${login_shell}." >&2`,
    `    echo "  SSH runs commands through the login shell: none would execute." >&2`,
    `    echo "  Give the account /bin/sh, then run this block again." >&2`,
    `    exit 1 ;;`,
    `esac`,
    ``,
    `# An account created with no password has a LOCKED password field, and an`,
    `# sshd WITHOUT PAM refuses a locked account even for public-key login — the`,
    `# same mid-run "Permission denied (publickey)" the guard above prevents. So`,
    `# warn unless sshd -T says usepam yes (an sshd built without PAM prints no`,
    `# usepam line at all); the key goes in either way. The shadow file is root's`,
    `# own to read; the pattern is quoted against interactive history expansion.`,
    `pw=$(awk -F: -v u=${user} '$1==u{print $2}' /etc/shadow 2>/dev/null) || pw=`,
    `case "\${pw:-}" in`,
    `  '!'*)`,
    `    usepam=$("$sshd" -T 2>/dev/null | grep -x 'usepam yes') || :`,
    `    if [ -z "$usepam" ]; then`,
    `      echo "appstrate: the password of ${user} is locked." >&2`,
    `      echo "  An sshd without PAM refuses a locked account, key or not." >&2`,
    `      echo "  To unlock it while keeping password login impossible:" >&2`,
    `      echo "    echo '${user}:*' | chpasswd -e" >&2`,
    `      echo "  Not passwd -u: on busybox it leaves the account with NO password." >&2`,
    `    fi ;;`,
    `esac`,
    ``,
    `# restrict turns off port forwarding, agent forwarding, X11 and pty. What`,
    `# this key may DO is what ${user} may do — restrict that account, not this`,
    `# line, if the agent should be able to do less. Guarded on the key's own`,
    `# base64, so replaying this block appends nothing a second time.`,
    `su -s /bin/sh ${user} <<'APPSTRATE_SSH'`,
    `set -eu`,
    `umask 077`,
    `mkdir -p ~/.ssh`,
    `keys=~/.ssh/authorized_keys`,
    `# A last line with no newline would take the append onto itself: the minted`,
    `# key unusable, the key already there mangled, and its base64 now in the`,
    `# file, so the guard below turns every replay into a silent no-op.`,
    `[ ! -s "$keys" ] || [ -z "$(tail -c1 "$keys")" ] || printf '\\n' >> "$keys"`,
    `grep -qF '${publicKeyBase64(publicKey)}' "$keys" 2>/dev/null ||`,
    `  printf '%s\\n' 'restrict ${publicKey} appstrate' >> "$keys"`,
    `APPSTRATE_SSH`,
    ``,
    `# Captured, not piped: a pipeline answers for its LAST command, so a missing`,
    `# or failing ssh-keygen would print the heading, then nothing, and succeed —`,
    `# an empty answer to the one question the user is here to ask.`,
    `echo`,
    `fp=$(ssh-keygen -lf ${hostKeyPub} 2>/dev/null | awk '{print $2}') || fp=`,
    `if [ -n "$fp" ]; then`,
    `  echo "fingerprint of this host:"`,
    `  echo "  $fp"`,
    `  echo "  ↳ compare it with the one Appstrate shows"`,
    `else`,
    `  echo "WARNING: no fingerprint could be read from ${hostKeyPub} — the key is" >&2`,
    `  echo "  installed, but compare the fingerprint by hand with:" >&2`,
    `  echo "    ssh-keygen -lf ${hostKeyPub}" >&2`,
    `fi`,
    `)`,
  ].join("\n");
}

/**
 * The block that removes this key (`grep -vF` on its base64), as the account and
 * in a subshell like {@link renderInstallCommand}.
 */
function renderRevokeCommand(user: string, publicKey: string): string {
  return [
    `# Paste as root (or with sudo) on the target, before or after deleting the`,
    `# connection in Appstrate. Deleting it destroys the private half there and`,
    `# nothing else — the platform cannot reach your machine to take its key out.`,
    `(`,
    `set -eu`,
    `su -s /bin/sh ${user} <<'APPSTRATE_SSH'`,
    `set -eu`,
    `keys=~/.ssh/authorized_keys`,
    `[ -f "$keys" ] || exit 0`,
    ``,
    `tmp=$(mktemp)`,
    `trap 'rm -f "$tmp"' EXIT`,
    `# grep answers 1 when nothing survived the filter: an empty result, not an`,
    `# error. Any other status is one, and must not reach the write below.`,
    `grep -vF '${publicKeyBase64(publicKey)}' "$keys" > "$tmp" || [ "$?" -eq 1 ]`,
    `# Written back THROUGH the file, so its inode, owner and mode survive.`,
    `cat "$tmp" > "$keys"`,
    `APPSTRATE_SSH`,
    `)`,
  ].join("\n");
}

/** Unix account name — interpolated into the script, so kept deliberately narrow. */
const USER_NAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

/**
 * The stored key, if it targets the SAME host/port/account and is readable —
 * a second pair would strand the installed line. Otherwise null: mint afresh.
 */
function reusableSshPrivateKey(
  existing: Record<string, unknown> | null,
  target: { host: string; port: string; user: string },
): string | null {
  if (!existing) return null;
  if (Object.entries(target).some(([name, value]) => existing[name] !== value)) return null;
  const stored = existing.private_key;
  if (typeof stored !== "string") return null;
  try {
    publicKeyFromOpenSshPrivateKey(stored);
  } catch {
    return null;
  }
  return stored;
}

async function provisionSshKeyPair(
  fields: SubmittedFields,
  existing: Record<string, unknown> | null,
): Promise<Record<string, string>> {
  const host = requiredString(fields, "host");
  const user = requiredString(fields, "user");
  if (!USER_NAME_RE.test(user)) {
    throw invalidRequest("`user` must be a Unix account name (lowercase, digits, - and _)");
  }

  const rawPort = fields["port"];
  const port = rawPort === undefined || rawPort === "" ? 22 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw invalidRequest("`port` must be a number between 1 and 65535");
  }

  // The RUNNER's egress floor (it ignores EGRESS_ALLOW_INTERNAL_HOSTS), on
  // literals only: nothing here connects to or resolves this host.
  if (isBlockedHost(host)) {
    throw invalidRequest(
      "runs cannot reach this host: it is a private, loopback or link-local address, " +
        "which the integration runner's egress refuses",
    );
  }

  // Checked only as far as this file interpolates it; shape is the manifest's.
  const hostKey = requiredString(fields, "host_key");
  hostKeyPubFile(hostKey);

  const target = { host, port: String(port), user };
  return {
    private_key: reusableSshPrivateKey(existing, target) ?? generateOpenSshEd25519PrivateKey(),
    ...target,
    host_key: hostKey,
  };
}

/**
 * The SSH steps, from the bundle alone. `[]` on an incomplete bundle, never a
 * half-built command: `grep -vF ''` would empty the file.
 */
function sshHandoffSteps(credentials: Record<string, unknown>): HandoffStep[] {
  const user = typeof credentials.user === "string" ? credentials.user.trim() : "";
  const privateKey = typeof credentials.private_key === "string" ? credentials.private_key : "";
  const hostKey = typeof credentials.host_key === "string" ? credentials.host_key.trim() : "";
  if (!USER_NAME_RE.test(user) || privateKey === "" || hostKey === "") return [];

  let publicKey: string;
  let hostKeyPub: string;
  let fingerprint: string;
  try {
    publicKey = publicKeyFromOpenSshPrivateKey(privateKey);
    hostKeyPub = hostKeyPubFile(hostKey);
    fingerprint = fingerprintPublicKey(hostKey);
  } catch {
    return [];
  }

  return [
    {
      kind: "command",
      id: "ssh_install",
      label: "Paste on the target server (as root, or with sudo)",
      shell: renderInstallCommand(user, publicKey, hostKeyPub),
    },
    {
      kind: "value",
      id: "ssh_host_fingerprint",
      label: "Host fingerprint, pinned",
      value: fingerprint,
      note:
        "The command above prints the server's fingerprint as its last line. " +
        "If it differs from this one, the host key you pinned is not this server's: " +
        "delete the connection and reconnect with the right one.",
    },
    {
      kind: "command",
      deferred: true,
      id: "ssh_revoke",
      label: "Remove this key from the server",
      shell: renderRevokeCommand(user, publicKey),
      note:
        "Keep this block, and run it before or after deleting the connection: once it is " +
        "deleted, Appstrate can no longer show it. Deleting the connection destroys the " +
        "private half and nothing else — Appstrate cannot reach your server to take its " +
        "key out of authorized_keys.",
    },
  ];
}

/** One provisioned auth: what it mints, the minting, and the steps it leaves the user. */
interface Provisioning {
  /** Names the platform owns: never read from a request body, never asked for. */
  provides: readonly string[];
  mint: (
    fields: SubmittedFields,
    existing: Record<string, unknown> | null,
  ) => Promise<Record<string, string>>;
  handoff: (credentials: Record<string, unknown>) => HandoffStep[];
}

/** Package id → auth key → provisioner. */
const PROVISIONING: ReadonlyMap<string, ReadonlyMap<string, Provisioning>> = new Map([
  [
    "@appstrate/ssh",
    new Map([
      [
        "primary",
        {
          // NOT `host_key`: the user supplies that.
          provides: ["private_key"],
          mint: provisionSshKeyPair,
          handoff: sshHandoffSteps,
        },
      ],
    ]),
  ],
]);

/** The provisioner of this system package's auth, or null. */
export function readProvisioning(packageId: string, authKey: string): Provisioning | null {
  if (!isSystemPackage(packageId)) return null;
  return PROVISIONING.get(packageId)?.get(authKey) ?? null;
}

/** The steps a connection's credentials imply; `[]` when there are none. */
export function handoffStepsFor(
  packageId: string,
  authKey: string,
  credentials: Record<string, unknown>,
): readonly HandoffStep[] {
  return readProvisioning(packageId, authKey)?.handoff(credentials) ?? [];
}

/**
 * A copy of the auth without the minted names in `credentials.schema`, for the
 * hosted form. Display only: submissions are validated against the full schema.
 */
export function authWithoutMintedCredentials<T>(packageId: string, authKey: string, auth: T): T {
  const provisioning = readProvisioning(packageId, authKey);
  if (!provisioning) return auth;
  const block = auth as { credentials?: { schema?: { properties?: unknown; required?: unknown } } };
  const schema = block.credentials?.schema;
  if (!schema) return auth;
  const minted = new Set<string>(provisioning.provides);
  // Each half only if declared: absent `properties` ≠ an empty object.
  const next = { ...schema };
  if (schema.properties && typeof schema.properties === "object") {
    next.properties = Object.fromEntries(
      Object.entries(schema.properties as Record<string, unknown>).filter(
        ([name]) => !minted.has(name),
      ),
    );
  }
  if (Array.isArray(schema.required)) {
    next.required = schema.required.filter((name) => !minted.has(name as string));
  }
  return { ...block, credentials: { ...block.credentials, schema: next } } as T;
}

/**
 * Run the auth's provisioner, or null. `existing` is the decrypted bundle of
 * a RECONNECTED connection (null on creation).
 */
export async function provisionCredentials(
  packageId: string,
  authKey: string,
  fields: SubmittedFields,
  existing: Record<string, unknown> | null,
): Promise<Record<string, string> | null> {
  const provisioning = readProvisioning(packageId, authKey);
  return provisioning ? provisioning.mint(fields, existing) : null;
}
