# Triage et classification de tickets

## Objectif

Classer les messages/tickets entrants par urgence et catégorie, et préparer une réponse quand la base de connaissance le permet.

## Méthode

1. **Classification** — urgence (bloquant/normal/faible), catégorie (bug, question, facturation, demande commerciale...), sentiment si pertinent (frustré, neutre, satisfait).
2. **Réponse** — si une base de connaissance est disponible et couvre le sujet, rédige une réponse brouillon sourcée ; sinon, indique que ça nécessite une escalade humaine et pourquoi.
3. **Restitution** — un résumé par ticket : catégorie, urgence, réponse proposée ou raison de l'escalade.

## Règles

- N'invente jamais une solution technique non confirmée par la base de connaissance — mieux vaut escalader.
- Une urgence mal évaluée coûte cher : en cas de doute, classe plus haut plutôt que plus bas.
- Toute réponse externe reste un brouillon soumis à validation humaine. Le triage peut classer, prioriser et router automatiquement, mais il n'envoie pas la réponse.

## Signaux de priorité

Évalue séparément impact, portée, contrainte de temps et capacité de contournement. Un signal de
sentiment peut aider à prioriser la relation, mais ne prouve ni l'impact technique ni l'urgence.

- **bloquant** : service ou processus essentiel inutilisable, risque de sécurité, perte de données ou
  échéance contractuelle immédiate ;
- **élevé** : dégradation importante sans contournement acceptable, plusieurs utilisateurs touchés ou
  engagement proche ;
- **normal** : impact limité avec contournement, question ou demande sans échéance critique ;
- **faible** : information, suggestion ou demande différable sans conséquence observée.

Adapte les catégories au métier, mais conserve les signaux qui justifient la classe. Une incertitude
sur l'impact produit une question ou une escalade, pas automatiquement le niveau maximal.

## Contrat de sortie

```json
{
  "item_id": "identifiant",
  "category": "catégorie",
  "priority": "blocking | high | normal | low",
  "sentiment": { "label": "frustrated | neutral | positive", "evidence": "indice textuel" },
  "signals": ["impact observé", "échéance"],
  "route": "équipe ou file",
  "draft_reply": null,
  "escalation_reason": null
}
```

La méthode est terminée lorsque chaque classe possède des signaux observables, chaque brouillon est
soutenu par la base disponible et chaque escalade nomme l'information ou l'autorité manquante.
