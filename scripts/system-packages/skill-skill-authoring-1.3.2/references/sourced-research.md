# Recherche sourcée (web)

## Objectif

Rechercher de l'information à jour sur un sujet, un concurrent ou un marché, et produire une synthèse structurée et sourcée.

## Méthode

1. **Cadrage** — précise ce qui est recherché (sujet, période, angle) avant de lancer la recherche.
2. **Recherche** — plusieurs requêtes complémentaires plutôt qu'une seule ; privilégie les sources primaires (site officiel, communiqué, doc produit) aux agrégateurs.
3. **Synthèse** — organise par thème, pas par source ; chaque affirmation cite sa source (nom + lien si disponible).
4. **Fraîcheur** — signale la date des sources trouvées, surtout sur un sujet qui évolue vite (pricing, feature, actualité).

## Règles

- Aucune affirmation sans source identifiable — une recherche sourcée n'est pas une opinion générale reformulée.
- Signale explicitement une information contradictoire entre sources plutôt que de trancher arbitrairement.
- Une recherche qui ne remonte rien de solide : dis-le, ne comble pas avec de la connaissance générale non vérifiée.

## Plan de recherche

Décompose la question en affirmations à vérifier avant d'interroger le web. Pour chacune, définis la
source qui ferait autorité, puis une source indépendante de contrôle lorsque l'enjeu le justifie.
Arrête la collecte quand chaque affirmation importante possède une preuve suffisante ou quand les
requêtes nouvelles ne changent plus la synthèse.

Hiérarchie indicative : document officiel ou donnée primaire, documentation ou déclaration du sujet,
publication spécialisée identifiable, agrégateur. Une source plus basse peut orienter la recherche,
mais elle ne doit pas remplacer une source primaire facilement disponible.

## Matrice de preuves

```json
{
  "claim": "affirmation précise",
  "status": "confirmed | disputed | unsupported",
  "sources": [{ "title": "...", "url": "...", "published_at": null }],
  "notes": "portée, méthode ou contradiction"
}
```

Rédige la synthèse par thème à partir de cette matrice, puis fournis les sources. Signale les dates de
consultation pour les pages sans date et distingue date de publication et date de l'événement.

La recherche est terminée lorsque les affirmations principales sont confirmées, contestées ou
marquées sans preuve, et que le lecteur peut retrouver la source de chacune.
