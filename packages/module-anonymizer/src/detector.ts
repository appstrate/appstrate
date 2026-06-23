// SPDX-License-Identifier: Apache-2.0

// Détecteur in-process : GLiNER2 (ONNX, in-Bun, sans Python/torch) + regex
// + deny-list + stop-list mots-rôle, avec masquage/restore RÉVERSIBLE.
// Port TS de l'ancien server.py. Même runtime ONNX que module-search.
//
// Implémente l'interface AnonBackend (anonymize/restore) → AnonSession
// l'utilise exactement comme l'ancien client HTTP.
//
// NB port : GLiNER2ONNXRuntime est chargé en `import()` DYNAMIQUE dans init()
// (le type seul est importé statiquement, donc effacé à la compilation). Ça
// garde le binding natif onnxruntime hors du chemin de boot du module : tant
// que personne n'appelle anonymize(), aucun .node n'est chargé. Le seam
// (palier b) est le premier vrai appelant.
import type { GLiNER2ONNXRuntime } from "@lmoe/gliner-onnx";
import type { Mapping } from "./run-session.ts";

// ---- Config (équivalent de config.yaml) — c'est ce que la boucle d'auto-amélioration fait évoluer ----
const GLINER_LABELS: Record<string, string> = {
  person: "PERSON",
  organization: "ORGANIZATION",
  address: "ADDRESS",
  "money amount": "MONEY",
  date: "DATE",
};
const GLINER_THRESHOLD = 0.5;

const REGEX: Record<string, RegExp> = {
  EMAIL: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  IBAN: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g,
  PHONE: /(?:\+?\d{1,2}[ .-]?)?(?:\(?\d{3}\)?[ .-]?)\d{3}[ .-]?\d{4}/g,
  CA_POSTAL: /\b[A-Z]\d[A-Z] ?\d[A-Z]\d\b/g,
  RBQ: /\b\d{4}-\d{4}-\d{2}\b/g,
};

const DENY: Record<string, string[]> = {
  INTERNAL_PROJECT: ["Appstrate", "Hindsight", "module-search", "module-storage"],
};

const STOPWORDS = new Set([
  "client",
  "le client",
  "la client",
  "prestataire",
  "prestataire de services",
  "directeur general",
  "directrice generale",
  "president",
  "employe",
  "employee",
  "partie",
  "parties",
  "une partie",
  "societe",
  "la societe",
  "personnes ressources",
  "personne-ressource",
  "membres de son personnel",
]);

const MODEL_ID = process.env.GLINER_MODEL ?? "lmo3/gliner2-multi-v1-onnx";

function norm(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}
function chunks(text: string, words = 250): string[] {
  const w = text.split(/\s+/);
  const out: string[] = [];
  for (let i = 0; i < w.length; i += words) out.push(w.slice(i, i + words).join(" "));
  return out;
}

interface Span {
  start: number;
  end: number;
  type: string;
  text: string;
  score: number;
}

export class InProcessDetector {
  private model: GLiNER2ONNXRuntime | null = null;
  private ready: Promise<void> | null = null;

  /** Charge le modèle une seule fois (lazy). */
  async init(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        const { GLiNER2ONNXRuntime } = await import("@lmoe/gliner-onnx");
        this.model = await GLiNER2ONNXRuntime.fromPretrained(MODEL_ID);
      })();
    }
    return this.ready;
  }

  private async detect(text: string): Promise<Span[]> {
    await this.init();
    const spans: Span[] = [];
    // 1) Regex (haute précision)
    for (const [type, rx] of Object.entries(REGEX)) {
      for (const m of text.matchAll(rx))
        spans.push({ start: m.index!, end: m.index! + m[0]!.length, type, text: m[0]!, score: 1 });
    }
    // 2) Deny-list métier
    for (const [type, words] of Object.entries(DENY)) {
      for (const w of words) {
        const rx = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
        for (const m of text.matchAll(rx))
          spans.push({
            start: m.index!,
            end: m.index! + m[0]!.length,
            type,
            text: m[0]!,
            score: 0.99,
          });
      }
    }
    // 3) GLiNER2 (NER contextuel) — par chunks, offsets recalés
    let offset = 0;
    for (const c of chunks(text)) {
      const idx = text.indexOf(c, offset);
      const base = idx === -1 ? offset : idx;
      const ents = await this.model!.extractEntities(c, Object.keys(GLINER_LABELS), {
        threshold: GLINER_THRESHOLD,
      });
      for (const e of ents) {
        if (STOPWORDS.has(norm(e.text))) continue; // filtre mots-rôle
        spans.push({
          start: base + e.start,
          end: base + e.end,
          type: GLINER_LABELS[e.label] ?? e.label.toUpperCase(),
          text: e.text,
          score: e.score,
        });
      }
      offset = base + c.length;
    }
    // 4) Résolution des chevauchements : meilleur score, puis plus long
    spans.sort((a, b) => b.score - a.score || b.end - b.start - (a.end - a.start));
    const kept: Span[] = [];
    for (const s of spans) {
      if (!kept.some((k) => s.start < k.end && k.start < s.end)) kept.push(s);
    }
    kept.sort((a, b) => a.start - b.start);
    return kept;
  }

  async anonymize(text: string, mapping?: Mapping): Promise<{ text: string; mapping: Mapping }> {
    const map: Mapping = { ...(mapping ?? {}) };
    const value2token: Record<string, string> = {};
    const counters: Record<string, number> = {};
    for (const [tok, v] of Object.entries(map)) {
      const parts = tok.replace(/^\[|\]$/g, "").split("_");
      const n = parts.pop()!;
      const type = parts.join("_");
      if (/^\d+$/.test(n)) {
        counters[type] = Math.max(counters[type] ?? 0, +n);
        value2token[`${type}::${norm(v)}`] = tok;
      }
    }
    const spans = await this.detect(text);
    let out = text;
    for (const s of [...spans].sort((a, b) => b.start - a.start)) {
      // fin -> début
      const key = `${s.type}::${norm(s.text)}`;
      let token = value2token[key];
      if (!token) {
        counters[s.type] = (counters[s.type] ?? 0) + 1;
        token = `[${s.type}_${counters[s.type]}]`;
        value2token[key] = token;
        map[token] = s.text;
      }
      out = out.slice(0, s.start) + token + out.slice(s.end);
    }
    return { text: out, mapping: map };
  }

  async restore(text: string, mapping: Mapping): Promise<string> {
    for (const token of Object.keys(mapping).sort((a, b) => b.length - a.length)) {
      text = text.split(token).join(mapping[token]!);
    }
    return text;
  }
}
