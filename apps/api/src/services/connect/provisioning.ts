// SPDX-License-Identifier: Apache-2.0

/**
 * Credential PROVISIONING — the credentials an integration's auth needs but
 * that the person connecting should never have to produce by hand.
 *
 * For SSH that is the key pair, and nothing else: a user pasting a private key
 * is almost always pasting their PERSONAL key, already installed on ten other
 * machines, so the blast radius of an Appstrate credential leaves Appstrate. A
 * minted pair is used nowhere else and is never displayed, typed or copied.
 * The host key goes the other way — the platform could only obtain it over an
 * unauthenticated first contact, exactly what a machine-in-the-middle answers,
 * while the user reads it off the machine from a session they already
 * authenticated. So it is asked for, not minted.
 *
 * An auth opts in through `_meta["dev.appstrate/provisioning"]` (AFPS §10):
 * `{ "kind": "ssh_keypair" }`. The manifest names the KIND and nothing else:
 * WHICH credentials a kind mints is a property of the provisioner, i.e. of the
 * code in this file, so {@link KINDS} is the one declaration of it. A manifest
 * is content-addressed and immutable once published, and a second copy of that
 * list inside one could only ever disagree with the provisioner it describes.
 *
 * {@link provisionCredentials} drops those names from the submitted bag, so a
 * client cannot supply its own `private_key`, and
 * {@link authWithoutMintedCredentials} takes them out of the schema the hosted
 * form renders, so nobody is asked to type a value about to be generated.
 *
 * {@link KINDS} is the whole registry, one entry per kind: what it mints, the
 * minting, and what the user is left holding afterwards.
 *
 * Provisioning does NOT bound the fields the user DOES supply: that is the
 * manifest's `credentials.schema`, validated by `FieldsStrategy` on EVERY path
 * that creates a connection — including the programmatic
 * `POST .../connect/fields` import, which never runs a provisioner.
 */

import { invalidRequest } from "../../lib/errors.ts";
import {
  fingerprintPublicKey,
  generateOpenSshEd25519KeyPair,
  parsePublicKeyLine,
  publicKeyFromOpenSshPrivateKey,
  type PublicKeyType,
} from "../../lib/openssh-key.ts";
import { isBlockedHost } from "@appstrate/afps-shared/ssrf";

/**
 * One thing the user has to do, or check, once the platform minted its half.
 *
 * Steps are DATA, not named fields: the SPA renders the list, so a new `kind`
 * ships without a front-end branch. Two shapes, both with a consumer today — a
 * block to run and a value to read; publisher prose is already `setup_guide`
 * (AFPS §7.10). Labels and notes are SERVER text, not i18n keys, because half
 * of a step (the shell block) is generated anyway.
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
       * reach the target to undo anything itself, and a teardown block shown
       * only once is a teardown nobody performs. The deletion surface renders
       * these and hides the rest; the creation surface does the opposite.
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
 * rather than derived: the path is interpolated into a script that runs as
 * root, and the set is exactly the two types `parsePublicKeyLine` admits.
 */
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
 * Render the one block the user pastes on the target: it authorises the minted
 * public key on the account they named, and nothing else.
 *
 * There is deliberately no `command=`: what an agent may do is what the ACCOUNT
 * may do, and narrowing that is the operator's act on their own machine — a
 * dedicated user, sudoers, a restricted shell. The setup guide says so.
 *
 * Everything interpolated is platform-minted or validated: the account against
 * {@link USER_NAME_RE}, the host-key file picked from a fixed table, the public
 * key rebuilt by `publicKeyFromOpenSshPrivateKey` as `ssh-ed25519 <base64>`
 * (never a string read out of the key container, which the programmatic import
 * door lets a caller choose), and the trailing comment a literal of this file's.
 * So nothing here can carry shell syntax across.
 *
 * It ends by printing the host fingerprint, from a session the user already
 * authenticated, so comparing it with what they pasted costs one glance.
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
    `keys=~${user}/.ssh/authorized_keys`,
    ``,
    `# restrict turns off port forwarding, agent forwarding, X11 and pty. What`,
    `# this key may DO is what ${user} may do — restrict that account, not this`,
    `# line, if the agent should be able to do less. Guarded on the key's own`,
    `# base64, so replaying this block appends nothing a second time.`,
    `grep -qF '${publicKeyBase64(publicKey)}' "$keys" 2>/dev/null ||`,
    `  printf '%s\\n' 'restrict ${publicKey} appstrate' >> "$keys"`,
    `chown ${user}:"$group" "$keys"`,
    `chmod 600 "$keys"`,
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
 * key's own base64 (`grep -F`, so none of its characters is a pattern), which
 * removes exactly this connection's line and no other.
 *
 * Two outcomes are ordinary rather than failures, and each would otherwise
 * destroy the file under `set -e`: no `authorized_keys` at all, and a `grep`
 * that matched every line — a file holding this key and no other.
 */
function renderRevokeCommand(user: string, publicKey: string): string {
  return [
    `# Paste as root (or with sudo) on the target AFTER deleting the connection`,
    `# in Appstrate. Deleting it destroys the private half here and nothing`,
    `# else — the platform cannot reach your machine to take its key out.`,
    `set -eu`,
    `keys=~${user}/.ssh/authorized_keys`,
    `[ -f "$keys" ] || exit 0`,
    ``,
    `tmp=$(mktemp)`,
    `trap 'rm -f "$tmp"' EXIT`,
    `# grep answers 1 when nothing survived the filter: an empty result, not an`,
    `# error. Any other status is one, and must not reach the write below.`,
    `grep -vF '${publicKeyBase64(publicKey)}' "$keys" > "$tmp" || [ "$?" -eq 1 ]`,
    `# Written back THROUGH the file, so its inode, owner and mode survive.`,
    `cat "$tmp" > "$keys"`,
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
  // does not honour: a connection created on the looser floor produces runs
  // that always fail. Literals only — nothing here opens a socket to this host,
  // so nothing here resolves its name either.
  if (isBlockedHost(host)) {
    throw invalidRequest(
      "runs cannot reach this host: it is a private, loopback or link-local address, " +
        "which the integration runner's egress refuses",
    );
  }

  // SUPPLIED, not scanned: a scan is an unauthenticated first contact, which
  // is what a machine-in-the-middle answers. Shape is the manifest's job
  // (`credentials.schema.pattern`, validated on BOTH doors); what is checked
  // here is only what this file interpolates into a root script.
  const hostKey = requiredString(fields, "host_key");
  hostKeyPubFile(hostKey);

  const keyPair = generateOpenSshEd25519KeyPair(`appstrate ${ctx.integrationId}`);

  // Credentials only: what the user must DO with them is rendered by
  // `sshHandoffSteps` from this very bundle, months later as well as now.
  return {
    private_key: keyPair.privateKey,
    host,
    port: String(port),
    user,
    host_key: hostKey,
  };
}

/**
 * Render every step a minted SSH connection implies, from the credential bundle
 * alone: the block to install, the fingerprint to compare, and the block that
 * takes the key back off the target later.
 *
 * DERIVED, never stored, on BOTH surfaces — the screen after the connect form
 * and the one handing the removal back months later call this same function, so
 * the two cannot disagree. Fail-soft: a bundle too incomplete to describe a
 * step yields an empty list rather than a half-built command, since a
 * `grep -vF ''` would empty the file it is meant to prune.
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
 * Every kind, and everything a kind IS — three halves that are not
 * independently optional: a kind shipping a provisioner and no `provides` would
 * mint a private key and then let a client supply its own. `handoff` renders
 * from the STORED bundle, so the screen after the form and the one months later
 * derive the same block instead of one of them replaying a copy.
 */
const KINDS: Record<
  string,
  {
    /** What the kind MINTS — the sole declaration of it, moving with `mint`. */
    provides: readonly string[];
    mint: (fields: SubmittedFields, ctx: ProvisionContext) => Promise<Record<string, string>>;
    handoff: (credentials: Record<string, unknown>) => HandoffStep[];
  }
> = {
  ssh_keypair: {
    // The only thing the platform mints. NOT `host_key`: the user supplies that.
    provides: ["private_key"],
    mint: provisionSshKeyPair,
    handoff: sshHandoffSteps,
  },
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
  return KINDS[declaration.kind]!.handoff(credentials);
}

export interface ProvisioningDeclaration {
  kind: string;
  /** Names the platform owns: never read from a request body, never asked for. */
  provides: readonly string[];
}

/**
 * Read `_meta["dev.appstrate/provisioning"]` off an auth block, or null when the
 * auth provisions nothing. Throws on a declared-but-unknown kind — falling back
 * to "the user types it" would silently drop a minted credential.
 */
export function readProvisioning(auth: unknown): ProvisioningDeclaration | null {
  const meta = (auth as { _meta?: Record<string, unknown> } | null)?._meta;
  const block = meta?.["dev.appstrate/provisioning"] as { kind?: unknown } | undefined;
  if (!block) return null;
  const kind = block.kind;
  if (typeof kind !== "string" || !(kind in KINDS)) {
    throw invalidRequest(`unknown credential provisioning kind: ${String(kind)}`);
  }
  return { kind, provides: KINDS[kind]!.provides };
}

/**
 * The same auth with the credentials the platform mints taken out of
 * `credentials.schema` — what the hosted connect form is handed, so it renders
 * inputs for what only the user can answer.
 *
 * Display only, and deliberately a SERVER answer: the stored shape genuinely
 * holds those names, so "what the form asks for" and "what a connection is
 * made of" are two different questions and the client should be answering
 * neither. Submitted bags are still validated against the FULL manifest schema,
 * and {@link provisionCredentials} drops these names whatever arrives.
 *
 * Returns a copy. The manifest it comes from is shared, so a strip written
 * through it would be a strip every later reader sees.
 */
export function authWithoutMintedCredentials<T>(auth: T): T {
  const declaration = readProvisioning(auth);
  if (declaration === null || declaration.provides.length === 0) return auth;
  const block = auth as { credentials?: { schema?: { properties?: unknown; required?: unknown } } };
  const schema = block.credentials?.schema;
  if (!schema) return auth;
  const minted = new Set<string>(declaration.provides);
  // Each half only if the manifest declares it: an absent `properties` means
  // "this auth names no fields", which an empty object would not.
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
  const result = await KINDS[declaration.kind]!.mint(fields, ctx);
  // Defence in depth: whatever the client sent for a provisioned name is
  // dropped, not merged, so a crafted body cannot smuggle in its own key.
  for (const name of declaration.provides) delete fields[name];
  return result;
}
