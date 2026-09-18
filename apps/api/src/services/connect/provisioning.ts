// SPDX-License-Identifier: Apache-2.0

/**
 * Credential PROVISIONING — the credentials an integration's auth needs but
 * that the person connecting should never have to produce by hand.
 *
 * The hosted connect form asks for what only the user knows (which host, which
 * account) and the platform derives the rest. For SSH that is the whole key
 * pair and the target's host key: a user pasting a private key is almost
 * always pasting their PERSONAL key, already installed on ten other machines,
 * so the blast radius of an Appstrate credential leaves Appstrate. A minted
 * pair is used nowhere else and is never displayed, typed, or copied.
 *
 * Shape: an auth opts in with
 *
 *     "_meta": {
 *       "dev.appstrate/provisioning": {
 *         "kind": "ssh_keypair",
 *         "provides": ["private_key", "host_key", "read_only"]
 *       }
 *     }
 *
 * (AFPS §10 vendor extension). `provides` is the ONE declaration of which
 * names the platform owns: the connect form reads it to hide those fields, and
 * {@link readProvisioning} checks it covers the kind's floor, so a manifest
 * that under-declares fails loudly instead of putting a mintable secret back
 * in front of the user. The registry below maps a `kind` to a function that
 * takes the submitted fields and returns the credentials to persist plus the
 * material to SHOW once. Provisioned names are merged over the submitted bag,
 * so a client cannot supply its own `private_key`.
 *
 * What provisioning does NOT bound: the shape of the fields the user DOES
 * supply. Those constraints live in the manifest's `credentials.schema`
 * (`pattern`), because that schema is validated by `FieldsStrategy` on EVERY
 * path that creates a connection — including the programmatic
 * `POST .../connect/fields` import, which never runs a provisioner.
 */

import { createHash } from "node:crypto";

import { invalidRequest } from "../../lib/errors.ts";
import { generateOpenSshEd25519KeyPair } from "../../lib/openssh-key.ts";
import { scanSshHostKey, type SshHostKeyScan } from "../../lib/ssh-host-key.ts";
import { isBlockedHost } from "@appstrate/afps-shared/ssrf";

/** What a provisioner produces. */
export interface ProvisionResult {
  /** Merged over the submitted credential bag before persistence. */
  credentials: Record<string, string>;
  /**
   * Shown to the user ONCE, on the screen that follows the connect form.
   * Never secret — this is the half that has to reach the target host.
   */
  display: ProvisionDisplay;
}

export interface ProvisionDisplay {
  /** `SHA256:…` of the TARGET's host key, for the user to compare. */
  host_fingerprint: string;
  /** A single shell block to paste on the target; installs the key + dispatcher. */
  install_command: string;
  /**
   * The block that undoes it. Deleting the connection destroys the private
   * half here and nothing else: the platform cannot reach the target to take
   * its own key out of `authorized_keys`, so the only way that line ever goes
   * away is someone pasting this.
   */
  revoke_command: string;
}

/** The submitted, not-yet-persisted credential bag. */
type SubmittedFields = Record<string, unknown>;

function requiredString(fields: SubmittedFields, name: string): string {
  const raw = fields[name];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "") throw invalidRequest(`\`${name}\` is required`);
  return value;
}

/**
 * Verbs the generated dispatcher knows how to run. A verb is a NAME on the
 * wire; the target decides what it executes, so the platform can only ship
 * implementations it can guarantee are read-only. Anything else is the
 * operator's to add by editing the script — and then to add here, in the
 * connection's allowlist.
 */
const DEFAULT_VERBS: Record<string, string> = {
  hostname: "exec hostname",
  uptime: "exec uptime",
  disk_usage: "exec df -h /",
  memory: "exec free -h",
  whoami: "exec id -un",
};

/** A verb name on the wire. Strict, because it is interpolated into a script. */
const VERB_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * Parse the connection's verb allowlist.
 *
 * An absent or empty value means NO verbs, never "all of them". Emptying a
 * permission field has to narrow it: the connect form seeds the manifest's
 * declared default, so someone who clears that box is asking for less, and a
 * caller that omits the field entirely has declared nothing to allow.
 */
function parseVerbs(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === "") return [];
  let parsed: unknown;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw invalidRequest("`allowed_verbs` must be a JSON array of names");
    }
  } else {
    parsed = raw;
  }
  if (!Array.isArray(parsed)) throw invalidRequest("`allowed_verbs` must be a JSON array of names");
  if (parsed.length === 0) return [];

  const verbs = parsed.map((v) => {
    if (typeof v !== "string" || !VERB_NAME_RE.test(v)) {
      throw invalidRequest(
        `verb ${JSON.stringify(v)} is not a valid name — lowercase letters, digits and _ only`,
      );
    }
    return v;
  });

  // Refuse a verb the generated script has no implementation for, rather than
  // writing a dispatcher that refuses it at run time. A connection whose
  // allowlist promises something the target cannot do is a lie the agent only
  // discovers mid-run.
  const unknown = verbs.filter((v) => !(v in DEFAULT_VERBS));
  if (unknown.length > 0) {
    throw invalidRequest(
      `the generated dispatcher implements ${Object.keys(DEFAULT_VERBS).join(", ")} — ` +
        `add ${unknown.join(", ")} to the script on the target first, then list it here`,
    );
  }
  return verbs;
}

/**
 * Where a target keeps the public half of the host key we pinned. Enumerated
 * rather than derived: this path is interpolated into a script that runs as
 * root, and the set is exactly what {@link scanSshHostKey} can return.
 */
const HOST_KEY_PUB_FILE: Record<string, string> = {
  "ssh-ed25519": "/etc/ssh/ssh_host_ed25519_key.pub",
  "ssh-rsa": "/etc/ssh/ssh_host_rsa_key.pub",
};

function hostKeyPubFile(hostKey: string): string {
  const type = hostKey.trim().split(/\s+/)[0] ?? "";
  const path = HOST_KEY_PUB_FILE[type];
  if (!path) throw invalidRequest(`unsupported host key type: ${type}`);
  return path;
}

/** The base64 field of an `authorized_keys` line — unique per key, and `grep -F`-safe. */
function publicKeyBase64(publicKey: string): string {
  return publicKey.trim().split(/\s+/)[1] ?? "";
}

/**
 * Render the one block the user pastes on the target. Everything
 * interpolated is either platform-minted (the key, the dispatcher path, the
 * host-key file) or has been validated against a strict character class (the
 * account, the verbs), so nothing here can carry shell syntax across.
 *
 * It ends by printing the host fingerprint: the user is already in a session
 * on that machine, authenticated by their own `known_hosts`, so comparing it
 * with what the connect screen shows costs one glance and is the only step
 * that can catch a machine-in-the-middle on the platform's scan.
 */
function renderInstallCommand(
  user: string,
  publicKey: string,
  verbs: string[],
  hostKeyPub: string,
  dispatchPath: string,
): string {
  const cases = verbs.map((verb) => `    ${verb}) ${DEFAULT_VERBS[verb]} ;;`).join("\n");

  return [
    `# Paste as root (or with sudo) on the target.`,
    `set -eu`,
    ``,
    `# A forced command runs through the account's LOGIN SHELL, so an account`,
    `# set to nologin refuses every verb — and it would only surface mid-run, as`,
    `# a verb that ran and produced nothing. Refuse here instead. What restricts`,
    `# this key is restrict + command=, not the absence of a shell.`,
    `login_shell=$(getent passwd ${user} 2>/dev/null | cut -d: -f7)`,
    `[ -n "\${login_shell:-}" ] || login_shell=$(awk -F: -v u=${user} '$1==u{print $7}' /etc/passwd)`,
    `case "\${login_shell:-}" in`,
    `  */nologin|*/false)`,
    `    echo "appstrate: le compte ${user} a pour shell \${login_shell}." >&2`,
    `    echo "  Un forced command SSH passe par le shell de login : aucun verbe ne s'exécuterait." >&2`,
    `    echo "  Donnez-lui /bin/sh, puis rejouez ce bloc." >&2`,
    `    exit 1 ;;`,
    `esac`,
    ``,
    `# The account's real primary group — assuming a group named after the user`,
    `# breaks on every box where it is not.`,
    `group=$(id -gn ${user})`,
    `install -d -m 700 -o ${user} -g "$group" ~${user}/.ssh`,
    ``,
    `# The forced command. It NEVER executes what the client asked for: the`,
    `# request arrives in SSH_ORIGINAL_COMMAND and is matched, exactly, against`,
    `# this closed list. Matching by prefix would let "uptime; rm -rf /" through.`,
    `#`,
    `# The path carries THIS key's fingerprint, so a second Appstrate connection`,
    `# to the same host installs its own dispatcher instead of overwriting this`,
    `# one — one connection's verb list can never widen another's.`,
    `cat > ${dispatchPath} <<'DISPATCH'`,
    `#!/bin/sh`,
    `request="\${SSH_ORIGINAL_COMMAND:-}"`,
    ``,
    `# sshd routes the sftp SUBSYSTEM through this same forced command, handing`,
    `# it the \`Subsystem sftp …\` line from sshd_config VERBATIM. With no arm for`,
    `# it the session dies before a packet and every file tool fails with an`,
    `# opaque "Connection closed". That line is not a bare path: it carries its`,
    `# arguments (\`internal-sftp -f AUTHPRIV -l INFO\` is a common default) and,`,
    `# measured on Ubuntu 24.04 / OpenSSH 9.6, a TRAILING SPACE. So match the`,
    `# program name only. A verb can contain neither a space nor a slash, so`,
    `# nothing else can reach this arm.`,
    `#`,
    `# -R is sftp-server's read-only mode: the connection is read_only on the`,
    `# platform side and the target enforces that rather than trusting it.`,
    `case "\${request%% *}" in`,
    `    */sftp-server|sftp-server|internal-sftp)`,
    `        for candidate in /usr/lib/openssh/sftp-server /usr/lib/ssh/sftp-server \\`,
    `                         /usr/libexec/openssh/sftp-server /usr/libexec/sftp-server; do`,
    `            [ -x "$candidate" ] && exec "$candidate" -R`,
    `        done`,
    `        echo "appstrate-dispatch: sftp-server introuvable sur cette machine" >&2; exit 3 ;;`,
    `esac`,
    ``,
    `case "$request" in`,
    cases,
    `    "") echo "appstrate-dispatch: no verb supplied" >&2; exit 2 ;;`,
    `    *)  echo "appstrate-dispatch: refused verb: $request" >&2; exit 42 ;;`,
    `esac`,
    `DISPATCH`,
    `chmod 0755 ${dispatchPath}`,
    ``,
    `# restrict turns off port forwarding, agent forwarding, X11 and pty.`,
    `printf '%s\\n' 'restrict,command="${dispatchPath}" ${publicKey}' \\`,
    `  >> ~${user}/.ssh/authorized_keys`,
    `chown ${user}:"$group" ~${user}/.ssh/authorized_keys`,
    `chmod 600 ~${user}/.ssh/authorized_keys`,
    ``,
    `echo`,
    `if [ -r ${hostKeyPub} ]; then`,
    `  echo "empreinte de cet hôte :"`,
    `  ssh-keygen -lf ${hostKeyPub} | awk '{print "  " $2}'`,
    `  echo "  ↳ comparez-la avec celle affichée dans Appstrate"`,
    `else`,
    `  echo "ATTENTION: ${hostKeyPub} est illisible — la clé est installée, mais" >&2`,
    `  echo "  l'empreinte n'a pas pu être imprimée. Comparez-la à la main avec :" >&2`,
    `  echo "    ssh-keygen -lf ${hostKeyPub}" >&2`,
    `fi`,
  ].join("\n");
}

/**
 * Render the block that takes this key back off the target. Matched on the
 * key's own base64 (`grep -F`, so none of its characters are a pattern), which
 * is what makes it remove exactly this connection's line and no other.
 */
function renderRevokeCommand(user: string, publicKey: string, dispatchPath: string): string {
  return [
    `# Paste as root (or with sudo) on the target AFTER deleting the connection`,
    `# in Appstrate. Deleting it destroys the private half here and nothing`,
    `# else — the platform cannot reach your machine to take its key out.`,
    `tmp=$(mktemp)`,
    `grep -vF '${publicKeyBase64(publicKey)}' ~${user}/.ssh/authorized_keys > "$tmp" || :`,
    `cat "$tmp" > ~${user}/.ssh/authorized_keys`,
    `rm -f "$tmp" ${dispatchPath}`,
  ].join("\n");
}

/** Unix account name — interpolated into the script, so kept deliberately narrow. */
const USER_NAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

/**
 * Context a provisioner runs in. `scanHostKey` is a seam: the happy path
 * reaches a real server over the network, which no unit test can do, yet the
 * script this function renders is the artefact that ends up writing to a
 * customer's `authorized_keys`. It is overridable so that script can be
 * asserted without one.
 */
export interface ProvisionContext {
  integrationId: string;
  scanHostKey?: (host: string, port: number) => Promise<SshHostKeyScan>;
}

async function provisionSshKeyPair(
  fields: SubmittedFields,
  ctx: ProvisionContext,
): Promise<ProvisionResult> {
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

  const verbs = parseVerbs(fields["allowed_verbs"]);

  // Mirror the RUNNER's egress floor, which is what actually has to reach this
  // host: `isBlockedHost` for a literal here, and the same resolve-and-check
  // inside `scanSshHostKey` — deliberately WITHOUT the operator's
  // EGRESS_ALLOW_INTERNAL_HOSTS allowlist, which the runner's CONNECT listener
  // does not honour. Creating a connection on the looser of the two floors
  // produces runs that always fail; the failure belongs at the form, where
  // someone can read it.
  if (isBlockedHost(host)) {
    throw invalidRequest(
      "runs cannot reach this host: it is a private, loopback or link-local address, " +
        "which the integration runner's egress refuses",
    );
  }

  const scan = await (ctx.scanHostKey ?? scanSshHostKey)(host, port);
  if (!scan.ok) {
    const detail = scan.detail ? ` (${scan.detail})` : "";
    throw invalidRequest(
      scan.reason === "blocked-host"
        ? "runs cannot reach this host: it resolves to a private, loopback or link-local " +
            `address, which the integration runner's egress refuses${detail}`
        : `the host key could not be read from ${host}:${port}${detail}`,
    );
  }

  const keyPair = generateOpenSshEd25519KeyPair(`appstrate ${ctx.integrationId}`);
  // One dispatcher per KEY, not per host: two connections to the same machine
  // must not share (and silently widen) a verb list.
  const keyId = createHash("sha256").update(keyPair.publicKey).digest("hex").slice(0, 12);
  const dispatchPath = `/usr/local/bin/appstrate-dispatch-${keyId}`;

  return {
    credentials: {
      private_key: keyPair.privateKey,
      host,
      port: String(port),
      user,
      host_key: scan.hostKey,
      allowed_verbs: JSON.stringify(verbs),
      // Read-only is the floor the SERVER applies; the target's own dispatcher
      // is the boundary that matters, and it runs nothing that writes (its
      // sftp arm execs `sftp-server -R`).
      read_only: "1",
    },
    display: {
      host_fingerprint: scan.fingerprint,
      install_command: renderInstallCommand(
        user,
        keyPair.publicKey,
        verbs,
        hostKeyPubFile(scan.hostKey),
        dispatchPath,
      ),
      revoke_command: renderRevokeCommand(user, keyPair.publicKey, dispatchPath),
    },
  };
}

type Provisioner = (fields: SubmittedFields, ctx: ProvisionContext) => Promise<ProvisionResult>;

const PROVISIONERS: Record<string, Provisioner> = {
  ssh_keypair: provisionSshKeyPair,
};

/**
 * The credential names a kind's provisioner OWNS, whatever its manifest says.
 * The manifest's `provides` is the single declaration everything reads — this
 * is the floor it must cover, so a manifest that forgets one cannot quietly
 * turn a minted secret back into a field the user is asked to type.
 */
const REQUIRED_PROVIDES: Record<string, readonly string[]> = {
  ssh_keypair: ["private_key", "host_key", "read_only"],
};

export interface ProvisioningDeclaration {
  kind: string;
  /** Names never read from the request body: the manifest's list, plus the floor. */
  provides: readonly string[];
}

/**
 * Read `_meta["dev.appstrate/provisioning"]` off an auth block, or null when
 * the auth provisions nothing. Throws on a declared-but-unknown kind — a
 * manifest asking for a provisioner this build does not have must fail loudly
 * rather than silently fall back to "the user types it" — and on a `provides`
 * that does not cover the kind's floor, which would put a mintable secret back
 * on the form.
 */
export function readProvisioning(auth: unknown): ProvisioningDeclaration | null {
  const meta = (auth as { _meta?: Record<string, unknown> } | null)?._meta;
  const block = meta?.["dev.appstrate/provisioning"] as
    { kind?: unknown; provides?: unknown } | undefined;
  if (!block) return null;
  const kind = block.kind;
  if (typeof kind !== "string" || !(kind in PROVISIONERS)) {
    throw invalidRequest(`unknown credential provisioning kind: ${String(kind)}`);
  }
  const declared = Array.isArray(block.provides)
    ? block.provides.filter((p): p is string => typeof p === "string")
    : [];
  const missing = (REQUIRED_PROVIDES[kind] ?? []).filter((name) => !declared.includes(name));
  if (missing.length > 0) {
    throw invalidRequest(
      `the '${kind}' provisioning declaration must list ${missing.join(", ")} in \`provides\` — ` +
        "the connect form reads that list to hide the fields the platform mints",
    );
  }
  return { kind, provides: [...new Set([...declared, ...(REQUIRED_PROVIDES[kind] ?? [])])] };
}

/**
 * Run the provisioner an auth declares. Returns null when it declares none,
 * so the caller keeps the plain "whatever was submitted" path.
 */
export async function provisionCredentials(
  auth: unknown,
  fields: SubmittedFields,
  ctx: ProvisionContext,
): Promise<ProvisionResult | null> {
  const declaration = readProvisioning(auth);
  if (!declaration) return null;
  const provisioner = PROVISIONERS[declaration.kind]!;
  const result = await provisioner(fields, ctx);
  // Defence in depth: whatever the client sent for a provisioned name is
  // dropped, not merged, so a crafted body cannot smuggle in its own key.
  for (const name of declaration.provides) delete fields[name];
  return result;
}
