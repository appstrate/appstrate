// SPDX-License-Identifier: Apache-2.0

/**
 * Vérifie qu'une carte de logique cite réellement ses sources.
 *
 * Pour chaque étape, relit le fichier cité et cherche la citation dans la fenêtre de
 * lignes annoncée. Trois issues : la citation est là (exacte), elle est ailleurs dans
 * le fichier (lignes fausses), ou elle n'y est pas du tout (inventée).
 *
 * C'est LE contrôle qui attrape une carte inventée, et il ne peut se faire qu'ici :
 * pendant le run qui produit la carte, quand le bundle est monté. Après coup, les
 * fichiers ne sont plus accessibles — c'est pour cette raison que ce script vit dans
 * un skill et non dans la plateforme.
 *
 * Aucun appel de modèle : comparaison de chaînes, rien d'autre.
 *
 *   bun verify-evidence.ts <carte.json> [racine-des-sources]
 *
 * Sort en code 1 dès qu'une citation est introuvable — une carte qui cite mal est
 * pire qu'une carte absente, puisqu'elle a l'apparence de la preuve.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface Evidence {
  file: string;
  lines: [number, number];
  quote: string;
}
interface Step {
  id: string;
  label: string;
  evidence: Evidence;
}

const [mapPath, rootArg] = process.argv.slice(2);
if (!mapPath) {
  console.error("usage: bun verify-evidence.ts <carte.json> [racine-des-sources]");
  process.exit(2);
}
const root = resolve(rootArg ?? ".");

const map = JSON.parse(readFileSync(mapPath, "utf8")) as {
  steps: Step[];
  source?: { files?: string[] };
};

/**
 * Normalisation avant comparaison.
 *
 * On tolère les différences d'espacement et de ponctuation décorative (backticks,
 * astérisques de markdown, guillemets typographiques) parce qu'elles ne changent pas
 * ce que la source PRESCRIT. On ne tolère rien d'autre : ni élision, ni reformulation.
 */
const norm = (s: string): string =>
  s
    .replace(/\s+/g, " ")
    .replace(/[`*_"'«»“”‘’]/g, "")
    .trim()
    .toLowerCase();

let exact = 0;
const misplaced: string[] = [];
const missing: string[] = [];
const unreadable: string[] = [];
const outsideSource: string[] = [];

const declared = new Set(map.source?.files ?? []);

for (const step of map.steps) {
  const ev = step.evidence;
  const path = join(root, ev.file);

  // Une citation qui pointe hors de `source.files` décrit un fichier que la carte ne
  // déclare pas avoir lu : le périmètre de lecture ment.
  if (declared.size > 0 && !declared.has(ev.file)) outsideSource.push(`${step.id} → ${ev.file}`);

  if (!existsSync(path)) {
    unreadable.push(`${step.id} → ${ev.file}`);
    continue;
  }

  const lines = readFileSync(path, "utf8").split("\n");
  const [from, to] = ev.lines;
  const window = norm(lines.slice(Math.max(0, from - 1), to).join(" "));
  const whole = norm(lines.join(" "));
  const quote = norm(ev.quote);

  if (window.includes(quote)) {
    exact++;
  } else if (whole.includes(quote)) {
    // La citation est réelle mais les lignes sont fausses : le clic renverra le lecteur
    // au mauvais endroit, ce qui ruine l'ancrage sans que rien ne le signale.
    let at: number | null = null;
    for (let i = 0; i < lines.length; i++) {
      if (norm(lines.slice(i, i + 3).join(" ")).includes(quote)) {
        at = i + 1;
        break;
      }
    }
    misplaced.push(`${step.id} annonce ${from}-${to}, trouvée vers ${at ?? "?"}`);
  } else {
    missing.push(`${step.id} — « ${ev.quote.slice(0, 70)}… »`);
  }
}

const total = map.steps.length;
const pct = (n: number) => ((n / Math.max(total, 1)) * 100).toFixed(1);

console.log(`${total} citations vérifiées`);
console.log(`  exactes       ${exact} (${pct(exact)} %)`);
console.log(`  mal située    ${misplaced.length}`);
console.log(`  introuvables  ${missing.length}`);
if (unreadable.length) console.log(`  source absente ${unreadable.length}`);
if (outsideSource.length) console.log(`  hors source.files ${outsideSource.length}`);

for (const m of missing) console.log(`  INTROUVABLE  ${m}`);
for (const m of misplaced) console.log(`  MAL SITUÉE   ${m}`);
for (const m of unreadable) console.log(`  ILLISIBLE    ${m}`);
for (const m of outsideSource) console.log(`  HORS PÉRIMÈTRE ${m}`);

// Une citation introuvable ou illisible invalide la carte ; des lignes fausses la
// rendent trompeuse. Les deux bloquent la publication.
process.exit(missing.length + unreadable.length + misplaced.length > 0 ? 1 : 0);
