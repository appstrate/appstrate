// SPDX-License-Identifier: Apache-2.0

// Session d'anonymisation = la "table de correspondance" qui vit le temps d'UN run
// (une conversation chat OU une boucle d'agent). C'est la piece centrale :
// les memes vraies valeurs gardent les memes jetons d'un bout a l'autre du run,
// pour que le restore-avant-outil et le restore-final soient coherents.
/** Table de correspondance jeton → vraie valeur, accumulée le temps d'un run. */
export type Mapping = Record<string, string>;

/** Backend de détection/masquage : implémenté par le détecteur in-process. */
export interface AnonBackend {
  anonymize(text: string, mapping?: Mapping): Promise<{ text: string; mapping: Mapping }>;
  restore(text: string, mapping: Mapping): Promise<string>;
}

export class AnonSession {
  private mapping: Mapping;
  /** `seed` = table de départ (continuité d'un run quand l'état vit ailleurs). */
  constructor(
    private backend: AnonBackend,
    seed?: Mapping,
  ) {
    this.mapping = seed ? { ...seed } : {};
  }

  /** Masque un texte et accumule la table du run. */
  async mask(text: string): Promise<string> {
    const res = await this.backend.anonymize(text, this.mapping);
    this.mapping = res.mapping; // backend renvoie la table fusionnee
    return res.text;
  }

  /** Restaure les vraies valeurs depuis la table du run. */
  async unmask(text: string): Promise<string> {
    return this.backend.restore(text, this.mapping);
  }

  /** Masque recursivement les strings d'un objet (args/result d'outil). */
  async maskDeep<T>(value: T): Promise<T> {
    return this.deepTransform(value, (s) => this.mask(s));
  }

  /** Restaure recursivement les strings d'un objet. */
  async unmaskDeep<T>(value: T): Promise<T> {
    return this.deepTransform(value, (s) => this.unmask(s));
  }

  /** Applique `fn` a chaque string en profondeur (string / array / objet). */
  private async deepTransform<T>(value: T, fn: (s: string) => Promise<string>): Promise<T> {
    if (typeof value === "string") return (await fn(value)) as unknown as T;
    if (Array.isArray(value))
      return Promise.all(value.map((v) => this.deepTransform(v, fn))) as unknown as T;
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = await this.deepTransform(v, fn);
      return out as T;
    }
    return value;
  }

  /** La table brute (a persister/auditer si besoin). */
  table(): Mapping {
    return { ...this.mapping };
  }
}
