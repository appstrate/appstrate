// SPDX-License-Identifier: Apache-2.0

/**
 * Every MinIO image the repo runs is ONE digest-pinned ref: the one
 * `docker-compose.yml`'s `appstrate-minio` pins, next to its refresh recipe.
 *
 * The ref is copied into every compose file that starts MinIO (the server and
 * its bucket-init container share it) and into the READMEs that print the
 * volume-ownership repair. A refresh that misses one copy leaves a server and
 * an `mc` of different releases, or a README pulling a digest nothing else
 * uses — both silent until someone runs that file. CHANGELOG entries are
 * excluded: a release note records the ref of its release.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPOSE_GLOBS, trackedFiles, trackedIndexFiles } from "../lib/tracked-files.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const PINNED_REF = /^cgr\.dev\/chainguard\/minio@sha256:[0-9a-f]{64}$/;
const IMAGE_LINE = /^\s*image:\s*["']?([^\s"'#]+)/;
const DOC_REF = /cgr\.dev\/chainguard\/minio@sha256:[0-9a-f]+/g;

interface Ref {
  file: string;
  line: number;
  ref: string;
}

function read(file: string): string[] {
  return readFileSync(join(REPO_ROOT, file), "utf-8").split("\n");
}

/** The `image:` of `docker-compose.yml`'s `appstrate-minio` service — the source of truth. */
function canonicalRef(): string {
  const lines = read("docker-compose.yml");
  const start = lines.indexOf("  appstrate-minio:");
  if (start === -1) throw new Error("docker-compose.yml has no `appstrate-minio` service");
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line)) break; // next service
    const m = IMAGE_LINE.exec(line);
    if (m) return m[1]!;
  }
  throw new Error("`appstrate-minio` in docker-compose.yml has no `image:`");
}

/** Every `image:` naming MinIO (server or `mc`, any registry) across the tracked compose files. */
function composeMinioRefs(): Ref[] {
  const refs: Ref[] = [];
  for (const file of trackedFiles(COMPOSE_GLOBS, "compose file", "fail")) {
    read(file).forEach((text, i) => {
      const m = IMAGE_LINE.exec(text);
      if (m && /minio/i.test(m[1]!)) refs.push({ file, line: i + 1, ref: m[1]! });
    });
  }
  return refs;
}

/** Every digest-pinned Chainguard MinIO ref printed in a tracked Markdown file, release notes excepted. */
function docMinioRefs(): Ref[] {
  const refs: Ref[] = [];
  for (const file of trackedIndexFiles(["*.md"], "Markdown file")) {
    if (file === "CHANGELOG.md" || file.endsWith("/CHANGELOG.md")) continue;
    read(file).forEach((text, i) => {
      for (const m of text.matchAll(DOC_REF)) refs.push({ file, line: i + 1, ref: m[0] });
    });
  }
  return refs;
}

const format = (refs: Ref[]) => refs.map((r) => `${r.file}:${r.line} ${r.ref}`);

describe("MinIO image ref", () => {
  const canonical = canonicalRef();

  it("is pinned by digest in docker-compose.yml", () => {
    expect(canonical).toMatch(PINNED_REF);
  });

  it("is the same ref in every compose file that runs MinIO", () => {
    const refs = composeMinioRefs();
    // Anchors, so a parser that stopped matching cannot pass on zero refs.
    const files = new Set(refs.map((r) => r.file));
    for (const anchor of [
      "docker-compose.yml",
      "deploy/docker-compose.yml",
      "test/setup/docker-compose.test.yml",
      "examples/self-hosting/docker-compose.tier3.yml",
    ]) {
      expect(files.has(anchor)).toBe(true);
    }
    expect(format(refs.filter((r) => r.ref !== canonical))).toEqual([]);
  });

  it("is the same ref in every README that prints it", () => {
    const refs = docMinioRefs();
    expect(refs.length).toBeGreaterThan(0);
    expect(format(refs.filter((r) => r.ref !== canonical))).toEqual([]);
  });
});
