// SPDX-License-Identifier: Apache-2.0

/**
 * Read a target's SSH host key at connect time, so a connection can pin it
 * before any agent ever runs.
 *
 * Why the platform scans at all: `ssh` normally acquires a host key by asking
 * the operator `Are you sure you want to continue connecting?` on first
 * contact and appending the answer to `known_hosts`. In an autonomous run
 * nobody is there to answer, and accepting silently would make a
 * machine-in-the-middle on that first connection permanent and invisible. So
 * the question is moved to the one moment a human IS present — creating the
 * connection — and this is what fetches the material that question is about.
 *
 * Why `ssh-keyscan` rather than an implementation here: the exchange that
 * yields a host key is a real SSH key exchange (version banner, KEXINIT,
 * algorithm negotiation, KEX_ECDH_INIT/REPLY). Re-deriving it would be a few
 * hundred lines of protocol code whose failure mode is "works against the
 * sshd I tested, refuses the one a customer runs". `ssh-keyscan` is the
 * reference implementation of exactly this operation; the platform image
 * carries `openssh-client` for it.
 *
 * The scan connects to the address the egress guard PINNED, never to the name
 * — resolving twice would reopen the DNS-rebind window the guard just closed.
 * One consequence worth knowing: for a name behind several A records this
 * pins the key of the host that answered. A later connection reaching a
 * different backend fails closed on the key mismatch, which is the correct
 * outcome — an SSH host key is per-host, and a fleet behind one name needs a
 * shared host key (or a connection per host).
 */

import { checkEgressHost } from "./egress-host-guard.ts";
import { fingerprintPublicKey } from "./openssh-key.ts";
import { logger } from "./logger.ts";

/**
 * Host key types worth pinning, best first. Ed25519 is preferred: fixed small
 * keys, no parameter choices to get wrong. RSA is the fallback for an sshd too
 * old to offer it. Deliberately NOT here: `ssh-dss` (DSA), removed from
 * OpenSSH and too weak to pin.
 */
const SCAN_TYPES = ["ed25519", "rsa"] as const;

/** Seconds `ssh-keyscan` waits for the banner + key exchange. */
const SCAN_TIMEOUT_SECONDS = 8;

/**
 * Hostnames and IP literals only. The value has already survived the egress
 * guard, but it is about to become a command ARGUMENT, and `ssh-keyscan` has
 * no `--` terminator — so a value starting with `-` would be read as a flag.
 * Anchored and character-restricted rather than blocklisting a leading dash.
 */
const SAFE_SCAN_HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.:-]{0,253}[A-Za-z0-9])?$/;

export type SshHostKeyScan =
  | {
      ok: true;
      /** `<type> <base64>` — what a connection pins and `known_hosts` renders. */
      hostKey: string;
      /** `SHA256:…`, the form a human compares against `ssh-keygen -l`. */
      fingerprint: string;
    }
  | {
      ok: false;
      reason: "blocked-host" | "unreachable" | "no-key";
      /** Operator-facing detail for logs and the connect form. Never a secret. */
      detail?: string;
    };

export interface ScanSshHostKeyOptions {
  /** Test seam — defaults to spawning the real `ssh-keyscan`. */
  runKeyscan?: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;
}

async function spawnKeyscan(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["ssh-keyscan", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

/**
 * Pick the strongest key from `ssh-keyscan` output. It prints one
 * `host type base64` line per type it obtained, plus `#`-prefixed comment
 * lines carrying the server banner.
 */
function selectHostKey(stdout: string): string | null {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));

  for (const wanted of SCAN_TYPES) {
    const type = `ssh-${wanted}`;
    for (const line of lines) {
      const fields = line.split(/\s+/);
      // `host type base64` — the host column is dropped: it is the pinned
      // address we dialled, and what a connection stores is the KEY, re-bound
      // to its own host and port when `known_hosts` is rendered.
      if (fields[1] === type && fields[2]) return `${fields[1]} ${fields[2]}`;
    }
  }
  return null;
}

/**
 * Fetch and fingerprint the host key of `host:port`.
 *
 * Non-throwing: returns a discriminated result, because every failure here is
 * something the person filling the connect form has to act on (wrong host,
 * firewall, private address) rather than a platform fault.
 */
export async function scanSshHostKey(
  host: string,
  port: number,
  opts: ScanSshHostKeyOptions = {},
): Promise<SshHostKeyScan> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, reason: "unreachable", detail: "port must be between 1 and 65535" };
  }

  // Same floor as every other platform egress: private, loopback, link-local
  // and cloud-metadata addresses are refused, after resolution so a name
  // cannot point at one. An SSH key would otherwise be a pivot into the
  // network the platform itself sits on.
  const gate = await checkEgressHost(host);
  if (gate.blocked) {
    return {
      ok: false,
      reason: "blocked-host",
      detail: "the host resolves to a private or otherwise blocked address",
    };
  }

  const target = gate.pinnedAddress;
  if (!SAFE_SCAN_HOST_RE.test(target)) {
    return { ok: false, reason: "unreachable", detail: "host is not a valid name or address" };
  }

  const run = opts.runKeyscan ?? spawnKeyscan;
  let result: { stdout: string; stderr: string; code: number };
  try {
    result = await run([
      "-T",
      String(SCAN_TIMEOUT_SECONDS),
      "-p",
      String(port),
      "-t",
      SCAN_TYPES.join(","),
      target,
    ]);
  } catch (err) {
    // The binary is missing or unspawnable — a deployment fault, not the
    // user's host. Say so distinctly so it is not read as "server unreachable".
    logger.error("ssh-keyscan could not be spawned", { err: String(err) });
    return { ok: false, reason: "unreachable", detail: "the host-key scanner is unavailable" };
  }

  const hostKey = selectHostKey(result.stdout);
  if (!hostKey) {
    // ssh-keyscan exits 0 with empty stdout for an unreachable host, so the
    // absence of a key — not the exit code — is what decides here.
    const detail = result.stderr.trim().split("\n").pop()?.slice(0, 200);
    return {
      ok: false,
      reason: result.stdout.trim() === "" ? "unreachable" : "no-key",
      ...(detail ? { detail } : {}),
    };
  }

  return { ok: true, hostKey, fingerprint: fingerprintPublicKey(hostKey) };
}
