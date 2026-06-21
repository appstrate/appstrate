// SPDX-License-Identifier: Apache-2.0

// Anonymiseur côté sidecar (palier b2 — Option S).
//
// La TABLE de correspondance du run vit ICI : le sidecar est le seul process qui
// couvre tout le run (forward LLM + exécution d'outils), donc la table est
// locale à ses deux consommateurs. La plateforme ne garde aucun état per-run.
//
//   - MASQUAGE  → exige la détection (GLiNER, centralisée) → appel HTTP à
//     l'endpoint `POST /internal/anonymize` (run-token), qui rend le corps
//     masqué + la table mise à jour.
//   - RESTORE   → n'exige AUCUNE détection (pure recherche jeton→valeur) → 100 %
//     LOCAL, gratuit. C'est tout l'intérêt de garder la table dans le sidecar.
//
// Le sidecar n'importe RIEN du module d'anonymisation : il parle uniquement par
// le seam (l'endpoint). Frontière propre, et zéro modèle dans l'image runner.

type Mapping = Record<string, string>;

export interface RunAnonymizer {
  /** Masque un corps de requête LLM via la plateforme ; accumule la table du run. */
  maskBody(bodyText: string): Promise<string>;
  /** Restaure les jetons d'un texte (réponse/erreur) — LOCAL, sans réseau. */
  restore(text: string): string;
  /** Restaure les jetons d'un flux SSE — LOCAL, par chunk (best-effort). */
  restoreStream(): TransformStream<Uint8Array, Uint8Array>;
  /** Masque EN PROFONDEUR une valeur (résultat d'outil) via la plateforme — détection requise. */
  maskDeep(value: unknown): Promise<unknown>;
  /** Restaure EN PROFONDEUR une valeur (args d'outil) — LOCAL, sans réseau. */
  restoreDeep(value: unknown): unknown;
}

export interface RunAnonymizerOptions {
  /** URL complète de l'endpoint, ex. `${platformApiUrl}/internal/anonymize`. */
  endpointUrl: string;
  /** Run-token HMAC (le même que pour `/internal/credentials`). */
  runToken: string;
  /** Injecté pour les tests ; défaut `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

const encoder = new TextEncoder();

/** Restore = recherche pure jeton→valeur, jetons les plus longs d'abord. */
function restoreLocal(text: string, mapping: Mapping): string {
  for (const token of Object.keys(mapping).sort((a, b) => b.length - a.length)) {
    text = text.split(token).join(mapping[token]!);
  }
  return text;
}

/** Restore récursif d'une valeur JSON (chaque string) — local, sans réseau. */
function restoreDeepLocal(value: unknown, mapping: Mapping): unknown {
  if (typeof value === "string") return restoreLocal(value, mapping);
  if (Array.isArray(value)) return value.map((v) => restoreDeepLocal(v, mapping));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = restoreDeepLocal(v, mapping);
    return out;
  }
  return value;
}

class HttpRunAnonymizer implements RunAnonymizer {
  private mapping: Mapping = {};
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: RunAnonymizerOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async maskBody(bodyText: string): Promise<string> {
    const res = await this.fetchImpl(this.opts.endpointUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.runToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        body: Buffer.from(bodyText, "utf8").toString("base64"),
        mapping: this.mapping,
      }),
    });
    if (!res.ok) {
      // Fail-CLOSED : mieux vaut faire échouer la requête LLM que laisser fuiter
      // de la PII en clair vers l'upstream. (b2.2b pourra raffiner la politique.)
      const detail = await res.text().catch(() => "");
      throw new Error(`anonymize endpoint ${res.status}: ${detail}`);
    }
    const out = (await res.json()) as { body: string; mapping: Mapping };
    this.mapping = out.mapping; // la plateforme rend la table fusionnée
    return Buffer.from(out.body, "base64").toString("utf8");
  }

  restore(text: string): string {
    return restoreLocal(text, this.mapping);
  }

  async maskDeep(value: unknown): Promise<unknown> {
    const res = await this.fetchImpl(this.opts.endpointUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.runToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ value, mapping: this.mapping }),
    });
    if (!res.ok) {
      // Fail-CLOSED : mieux vaut faire échouer l'appel d'outil que rendre au LLM
      // un résultat porteur de PII en clair.
      const detail = await res.text().catch(() => "");
      throw new Error(`anonymize(deep) endpoint ${res.status}: ${detail}`);
    }
    const out = (await res.json()) as { value: unknown; mapping: Mapping };
    this.mapping = out.mapping;
    return out.value;
  }

  restoreDeep(value: unknown): unknown {
    return restoreDeepLocal(value, this.mapping);
  }

  restoreStream(): TransformStream<Uint8Array, Uint8Array> {
    const mappingRef = () => this.mapping;
    // Décodeur à état : ne coupe pas un caractère multi-octets entre chunks.
    // Best-effort : un jeton scindé entre deux chunks ne sera pas restauré.
    const streamDecoder = new TextDecoder();
    return new TransformStream({
      transform(chunk, controller) {
        const restored = restoreLocal(streamDecoder.decode(chunk, { stream: true }), mappingRef());
        controller.enqueue(encoder.encode(restored));
      },
    });
  }
}

export function createRunAnonymizer(opts: RunAnonymizerOptions): RunAnonymizer {
  return new HttpRunAnonymizer(opts);
}

/**
 * Enveloppe un outil (palier b2.3) : le LLM raisonne en jetons, donc il appelle
 * l'outil avec des jetons dans les args.
 *   - RESTORE les args AVANT exécution (l'outil agit sur les vraies valeurs) — LOCAL.
 *   - RE-MASQUE le résultat APRÈS (le LLM ne revoit que des jetons) — via l'endpoint.
 * Générique sur la forme `{ handler }` pour ne pas coupler aux types MCP.
 */
export function wrapToolHandler<T extends { handler: (args: any, extra: any) => Promise<any> }>(
  tool: T,
  anon: RunAnonymizer,
): T {
  const original = tool.handler;
  return {
    ...tool,
    handler: async (args: any, extra: any) => {
      const realArgs = anon.restoreDeep(args); // jetons → vraies valeurs (local)
      const result = await original(realArgs, extra); // l'outil agit pour de vrai
      return anon.maskDeep(result); // résultat → jetons (endpoint)
    },
  };
}
