// SPDX-License-Identifier: Apache-2.0

/**
 * Credential PROVISIONING — the credentials an integration's auth needs but
 * that the person connecting should never have to produce by hand.
 *
 * The hosted connect form asks for what only the user knows and the platform
 * mints the rest. For SSH that is the key pair, and nothing else: a user
 * pasting a private key is almost always pasting their PERSONAL key, already
 * installed on ten other machines, so the blast radius of an Appstrate
 * credential leaves Appstrate. A minted pair is used nowhere else and is never
 * displayed, typed, or copied.
 *
 * The line is "can the platform produce this better than the user can", not
 * "can the platform produce it at all". The target's host key is the case
 * that decides the difference: the platform CAN fetch it, and used to — but
 * only over an unauthenticated first contact, which is the exact thing a
 * machine-in-the-middle answers. The user reads it off the machine from a
 * session they already authenticated. So it is asked for, not minted.
 *
 * Shape: an auth opts in with
 *
 *     "_meta": {
 *       "dev.appstrate/provisioning": {
 *         "kind": "ssh_keypair",
 *         "provides": ["private_key"]
 *       }
 *     }
 *
 * (AFPS §10 vendor extension). `provides` is the ONE declaration of which
 * names the platform owns: the connect form reads it to hide those fields, and
 * {@link readProvisioning} checks it covers the kind's floor, so a manifest
 * that under-declares fails loudly instead of putting a mintable secret back
 * in front of the user. Provisioned names are merged over the submitted bag,
 * so a client cannot supply its own `private_key`.
 *
 * Two tables, one per half, both keyed by `kind`: {@link PROVISIONERS} mints
 * the credentials, {@link HANDOFFS} renders what the user is left holding —
 * from the STORED bundle, so the screen after the form and the one months
 * later derive the same block instead of one of them replaying a copy.
 *
 * What provisioning does NOT bound: the shape of the fields the user DOES
 * supply. Those constraints live in the manifest's `credentials.schema`
 * (`pattern`), because that schema is validated by `FieldsStrategy` on EVERY
 * path that creates a connection — including the programmatic
 * `POST .../connect/fields` import, which never runs a provisioner.
 */

import { invalidRequest } from "../../lib/errors.ts";
import {
  fingerprintPublicKey,
  generateOpenSshEd25519KeyPair,
  publicKeyFromOpenSshPrivateKey,
} from "../../lib/openssh-key.ts";
import { isBlockedHost } from "@appstrate/afps-shared/ssrf";

/**
 * One thing the user has to do, or check, once the platform has minted its half.
 *
 * Steps are DATA, not three named fields, because every provisioner hands back
 * a different set of them and the SPA must not grow a branch per kind: it
 * renders the list, and a new `kind` of provisioning ships without touching the
 * front end. Two shapes, both with a consumer today — a block to run, and a
 * value to read. A prose step would be a third with none: publisher prose is
 * already `setup_guide` (AFPS §7.10) with its own renderer.
 *
 * Labels and notes are SERVER text, like `setup_guide`'s, not i18n keys: the
 * step's content is the provisioner's to word, and half of it (a shell block) is
 * generated anyway.
 */
export type HandoffStep =
  | {
      kind: "command";
      label: string;
      /** Shell to run on the target. Copied, never executed by the platform. */
      shell: string;
      note?: string;
      /**
       * Not now — kept for when the connection is deleted. The platform cannot
       * reach the target to undo anything itself, so a teardown block that is
       * only ever shown once is a teardown nobody performs. A surface showing
       * the list at deletion time renders these and hides the rest; the
       * surface that follows creation does the opposite.
       */
      deferred?: boolean;
    }
  | { kind: "value"; label: string; value: string; note?: string };

/** The submitted, not-yet-persisted credential bag. */
type SubmittedFields = Record<string, unknown>;

function requiredString(fields: SubmittedFields, name: string): string {
  const raw = fields[name];
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value === "") throw invalidRequest(`\`${name}\` is required`);
  return value;
}

/**
 * Where a target keeps the public half of the host key we pinned. Enumerated
 * rather than derived: this path is interpolated into a script that runs as
 * root, and the set is exactly the two types the manifest's `host_key`
 * `pattern` admits.
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
 * Render the one block the user pastes on the target: it authorises the minted
 * public key on the account they named, and nothing else.
 *
 * `restrict` turns off port forwarding, agent forwarding, X11 and pty. There is
 * deliberately no `command=`. An earlier cut generated a forced-command
 * dispatcher with one arm per allowed verb, which made the connection's
 * capability fixed at creation — adding a verb meant a new key, a new
 * dispatcher and a new connection, because the dispatcher's path carried the
 * key's fingerprint. What an agent may do is now what the ACCOUNT may do, and
 * narrowing that is the operator's act on their own machine: a dedicated user,
 * sudoers, a restricted shell. The setup guide says so in as many words,
 * because a posture that is not written down is a posture nobody chose.
 *
 * Everything interpolated is either platform-minted (the key, the host-key
 * file) or validated against a strict character class (the account), so
 * nothing here can carry shell syntax across.
 *
 * It ends by printing the host fingerprint: the user is already in a session on
 * that machine, authenticated by their own `known_hosts`, so comparing it with
 * what they pasted into the form costs one glance.
 */
function renderInstallCommand(user: string, publicKey: string, hostKeyPub: string): string {
  return [
    `# Paste as root (or with sudo) on the target.`,
    `set -eu`,
    ``,
    `# sshd runs a command through the account's LOGIN SHELL, so an account set`,
    `# to nologin runs nothing — and it would only surface mid-run, as a command`,
    `# that produced no output. Refuse here instead.`,
    `login_shell=$(getent passwd ${user} 2>/dev/null | cut -d: -f7)`,
    `[ -n "\${login_shell:-}" ] || login_shell=$(awk -F: -v u=${user} '$1==u{print $7}' /etc/passwd)`,
    `case "\${login_shell:-}" in`,
    `  */nologin|*/false)`,
    `    echo "appstrate: le compte ${user} a pour shell \${login_shell}." >&2`,
    `    echo "  SSH passe par le shell de login : aucune commande ne s'exécuterait." >&2`,
    `    echo "  Donnez-lui /bin/sh, puis rejouez ce bloc." >&2`,
    `    exit 1 ;;`,
    `esac`,
    ``,
    `# The account's real primary group — assuming a group named after the user`,
    `# breaks on every box where it is not.`,
    `group=$(id -gn ${user})`,
    `install -d -m 700 -o ${user} -g "$group" ~${user}/.ssh`,
    ``,
    `# restrict turns off port forwarding, agent forwarding, X11 and pty. What`,
    `# this key may DO is what ${user} may do — restrict that account, not this`,
    `# line, if the agent should be able to do less.`,
    `printf '%s\\n' 'restrict ${publicKey}' >> ~${user}/.ssh/authorized_keys`,
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
function renderRevokeCommand(user: string, publicKey: string): string {
  return [
    `# Paste as root (or with sudo) on the target AFTER deleting the connection`,
    `# in Appstrate. Deleting it destroys the private half here and nothing`,
    `# else — the platform cannot reach your machine to take its key out.`,
    `tmp=$(mktemp)`,
    `grep -vF '${publicKeyBase64(publicKey)}' ~${user}/.ssh/authorized_keys > "$tmp" || :`,
    `cat "$tmp" > ~${user}/.ssh/authorized_keys`,
    `rm -f "$tmp"`,
  ].join("\n");
}

/** Unix account name — interpolated into the script, so kept deliberately narrow. */
const USER_NAME_RE = /^[a-z_][a-z0-9_-]{0,31}$/;

/** Context a provisioner runs in. */
export interface ProvisionContext {
  integrationId: string;
}

async function provisionSshKeyPair(
  fields: SubmittedFields,
  ctx: ProvisionContext,
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

  // Mirror the RUNNER's egress floor — deliberately WITHOUT the operator's
  // EGRESS_ALLOW_INTERNAL_HOSTS allowlist, which the runner's CONNECT listener
  // does not honour. Creating a connection on the looser of the two floors
  // produces runs that always fail; the failure belongs at the form, where
  // someone can read it. A literal only: this no longer resolves the name,
  // because nothing here opens a socket any more.
  if (isBlockedHost(host)) {
    throw invalidRequest(
      "runs cannot reach this host: it is a private, loopback or link-local address, " +
        "which the integration runner's egress refuses",
    );
  }

  // The host key is SUPPLIED, not scanned.
  //
  // The platform used to run `ssh-keyscan` here. That put an SSH client in
  // every self-hosted image for one call, and — the part that actually
  // decides it — a scan is an UNAUTHENTICATED first contact: precisely what a
  // machine-in-the-middle answers. Its only defence was asking the user to
  // compare two strings afterwards. The install block already prints this key
  // from inside a session the user authenticated with their own
  // `known_hosts`, so taking it from there instead removes the window rather
  // than papering over it, and the comparison step stops being theatre.
  //
  // Shape is the manifest's job (`credentials.schema.pattern`, validated by
  // `FieldsStrategy` on BOTH doors). What is checked here is only what this
  // file is about to interpolate into a root script.
  const hostKey = requiredString(fields, "host_key");
  hostKeyPubFile(hostKey);

  const keyPair = generateOpenSshEd25519KeyPair(`appstrate ${ctx.integrationId}`);

  // Credentials only. What the user must DO with them is rendered by
  // `sshHandoffSteps` from this very bundle — the same function the connection
  // detail surface calls months later, so the two can never disagree.
  return {
    private_key: keyPair.privateKey,
    host,
    port: String(port),
    user,
    host_key: hostKey,
  };
}

/**
 * Render every step a minted SSH connection implies, from the credential
 * bundle alone: the block to install, the fingerprint to compare, and the
 * block that takes the key back off the target later.
 *
 * DERIVED, never stored — and derived on BOTH surfaces, which is the point.
 * The screen that follows the connect form and the one that hands the removal
 * back months later call this same function, so the block a user is given at
 * deletion cannot disagree with the one they installed. Persisting any of it
 * was tried and reverted: an `openssh-key-v1` container carries its own public
 * half in the clear beside the private one (which is why `ssh-keygen -y`
 * answers instantly on an unencrypted key) and the fingerprint is a pure
 * function of the pinned host key, so a column would have bought a permanent
 * migration for data that cannot be missing, plus a stored copy free to drift
 * from the key it claims to remove.
 *
 * Fail-soft: a bundle too incomplete to describe a step yields an empty list
 * rather than a half-built command — a surface must render nothing rather than
 * a `grep -vF ''` that would empty the file it is meant to prune. At creation
 * time that branch is unreachable, because `provisionSshKeyPair` produced the
 * bundle and validated every field on the way in; `connect-provisioning.test.ts`
 * asserts the list non-empty there, so a regression making the happy path
 * soft-fail turns red instead of silently handing back nothing.
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
      label: "À coller sur le serveur cible (en root, ou avec sudo)",
      shell: renderInstallCommand(user, publicKey, hostKeyPub),
    },
    {
      kind: "value",
      label: "Empreinte de l'hôte, épinglée",
      value: fingerprint,
      note:
        "La commande ci-dessus imprime l'empreinte du serveur en dernière ligne. " +
        "Si elle diffère de celle-ci, quelqu'un s'est intercalé : supprimez la connexion.",
    },
    {
      kind: "command",
      deferred: true,
      label: "Retirer cette clé du serveur",
      shell: renderRevokeCommand(user, publicKey),
      note:
        "Gardez ce bloc. Supprimer la connexion dans Appstrate détruit la moitié privée et " +
        "rien d'autre — Appstrate ne peut pas atteindre votre serveur pour retirer sa clé " +
        "d'authorized_keys.",
    },
  ];
}

/**
 * Per-kind step renderers, read from a stored credential bundle.
 *
 * A table for the same reason {@link PROVISIONERS} is one: a kind that mints
 * something must not be able to ship its provisioner and forget what the user
 * is left holding. Branching on the kind inside the function below would let
 * exactly that through — it did, until this became a table.
 */
const HANDOFFS: Record<string, (credentials: Record<string, unknown>) => HandoffStep[]> = {
  ssh_keypair: sshHandoffSteps,
};

/**
 * The steps a connection's credentials imply, for an auth that provisions.
 *
 * Empty for an auth that provisions nothing, for a kind that leaves nothing
 * behind, and for a bundle too incomplete to describe a step — a caller
 * renders nothing rather than a half-built command.
 */
export function handoffStepsFor(
  auth: unknown,
  credentials: Record<string, unknown>,
): readonly HandoffStep[] {
  let declaration: ProvisioningDeclaration | null;
  try {
    declaration = readProvisioning(auth);
  } catch {
    // A manifest this build cannot read is not a reason to refuse a deletion.
    return [];
  }
  if (!declaration) return [];
  return HANDOFFS[declaration.kind]?.(credentials) ?? [];
}

type Provisioner = (
  fields: SubmittedFields,
  ctx: ProvisionContext,
) => Promise<Record<string, string>>;

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
  // NOT `host_key`: the user supplies it, read off the target from a session
  // they authenticated themselves. Only what the platform actually mints.
  // `private_key` alone: it is the only thing the platform mints. Everything
  // else on this auth is the user's to supply.
  ssh_keypair: ["private_key"],
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
): Promise<Record<string, string> | null> {
  const declaration = readProvisioning(auth);
  if (!declaration) return null;
  const provisioner = PROVISIONERS[declaration.kind]!;
  const result = await provisioner(fields, ctx);
  // Defence in depth: whatever the client sent for a provisioned name is
  // dropped, not merged, so a crafted body cannot smuggle in its own key.
  for (const name of declaration.provides) delete fields[name];
  return result;
}
