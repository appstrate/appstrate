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
 *     "_meta": { "dev.appstrate/provisioning": { "kind": "ssh_keypair" } }
 *
 * (AFPS §10 vendor extension). The registry below maps a `kind` to a function
 * that takes the submitted fields and returns the credentials to persist plus
 * the material to SHOW once. Provisioned names are merged over the submitted
 * bag, so a client cannot supply its own `private_key` and have it kept.
 */

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
  /** Short heading key the SPA localises (`integration.connect.provisioned.*`). */
  kind: string;
  /** `SHA256:…` of the TARGET's host key, for the user to compare. */
  host_fingerprint: string;
  /** The `authorized_keys` line the platform minted the private half of. */
  public_key: string;
  /** A single shell block to paste on the target; installs the key + dispatcher. */
  install_command: string;
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

function parseVerbs(raw: unknown): string[] {
  if (raw === undefined || raw === null || raw === "") return Object.keys(DEFAULT_VERBS);
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
 * Render the one block the user pastes on the target. Everything
 * interpolated is either platform-minted (the key) or has been validated
 * against a strict character class (the account, the verbs), so nothing here
 * can carry shell syntax across.
 *
 * It ends by printing the host fingerprint: the user is already in a session
 * on that machine, authenticated by their own `known_hosts`, so comparing it
 * with what the connect screen shows costs one glance and is the only step
 * that can catch a machine-in-the-middle on the platform's scan.
 */
function renderInstallCommand(user: string, publicKey: string, verbs: string[]): string {
  const cases = verbs.map((verb) => `    ${verb}) ${DEFAULT_VERBS[verb]} ;;`).join("\n");

  return [
    `# Paste as root (or with sudo) on the target.`,
    `set -eu`,
    `install -d -m 700 -o ${user} -g ${user} ~${user}/.ssh`,
    ``,
    `# The forced command. It NEVER executes what the client asked for: the`,
    `# request arrives in SSH_ORIGINAL_COMMAND and is matched, exactly, against`,
    `# this closed list. Matching by prefix would let "uptime; rm -rf /" through.`,
    `cat > /usr/local/bin/appstrate-dispatch <<'DISPATCH'`,
    `#!/bin/sh`,
    `case "\${SSH_ORIGINAL_COMMAND:-}" in`,
    cases,
    `    "") echo "appstrate-dispatch: no verb supplied" >&2; exit 2 ;;`,
    `    *)  echo "appstrate-dispatch: refused verb: \${SSH_ORIGINAL_COMMAND}" >&2; exit 42 ;;`,
    `esac`,
    `DISPATCH`,
    `chmod 0755 /usr/local/bin/appstrate-dispatch`,
    ``,
    `# restrict turns off port forwarding, agent forwarding, X11 and pty.`,
    `printf '%s\\n' 'restrict,command="/usr/local/bin/appstrate-dispatch" ${publicKey}' \\`,
    `  >> ~${user}/.ssh/authorized_keys`,
    `chown ${user}:${user} ~${user}/.ssh/authorized_keys`,
    `chmod 600 ~${user}/.ssh/authorized_keys`,
    ``,
    `echo`,
    `echo "empreinte de cet hôte :"`,
    `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub | awk '{print "  " $2}'`,
    `echo "  ↳ comparez-la avec celle affichée dans Appstrate"`,
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

  // The runner's CONNECT egress applies a LITERAL floor with no operator
  // allowlist (`isBlockedHost`), while the platform's own guard honours
  // EGRESS_ALLOW_INTERNAL_HOSTS. Refusing here on the stricter of the two
  // keeps a connection from being created that every run would then fail to
  // use — the failure belongs at the form, where someone can read it.
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
        ? `the host key could not be read: the address is blocked${detail}`
        : `the host key could not be read from ${host}:${port}${detail}`,
    );
  }

  const keyPair = generateOpenSshEd25519KeyPair(`appstrate ${ctx.integrationId}`);

  return {
    credentials: {
      private_key: keyPair.privateKey,
      host,
      port: String(port),
      user,
      host_key: scan.hostKey,
      allowed_verbs: JSON.stringify(verbs),
      // Read-only is the floor the SERVER applies; the target's own dispatcher
      // is the boundary that matters, and it runs nothing that writes.
      read_only: "1",
    },
    display: {
      kind: "ssh_keypair",
      host_fingerprint: scan.fingerprint,
      public_key: keyPair.publicKey,
      install_command: renderInstallCommand(user, keyPair.publicKey, verbs),
    },
  };
}

type Provisioner = (fields: SubmittedFields, ctx: ProvisionContext) => Promise<ProvisionResult>;

const PROVISIONERS: Record<string, Provisioner> = {
  ssh_keypair: provisionSshKeyPair,
};

/** Credential names a provisioner owns — never read from the request body. */
const PROVISIONED_FIELDS: Record<string, readonly string[]> = {
  ssh_keypair: ["private_key", "host_key", "read_only"],
};

/**
 * Read `_meta["dev.appstrate/provisioning"].kind` off an auth block, or null
 * when the auth provisions nothing. Throws on a declared-but-unknown kind: a
 * manifest asking for a provisioner this build does not have must fail loudly
 * rather than silently fall back to "the user types it".
 */
export function provisioningKind(auth: unknown): string | null {
  const meta = (auth as { _meta?: Record<string, unknown> } | null)?._meta;
  const block = meta?.["dev.appstrate/provisioning"] as { kind?: unknown } | undefined;
  if (!block) return null;
  const kind = block.kind;
  if (typeof kind !== "string" || !(kind in PROVISIONERS)) {
    throw invalidRequest(`unknown credential provisioning kind: ${String(kind)}`);
  }
  return kind;
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
  const kind = provisioningKind(auth);
  if (!kind) return null;
  const provisioner = PROVISIONERS[kind]!;
  const result = await provisioner(fields, ctx);
  // Defence in depth: whatever the client sent for a provisioned name is
  // dropped, not merged, so a crafted body cannot smuggle in its own key.
  for (const name of PROVISIONED_FIELDS[kind] ?? []) delete fields[name];
  return result;
}
