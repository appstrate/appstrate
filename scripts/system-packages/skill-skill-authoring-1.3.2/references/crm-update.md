# Mise à jour CRM et suivi de pipeline

## Objectif

Enrichir un lead, journaliser une interaction, ou signaler une opportunité qui a besoin d'attention — dans le CRM connecté, quel qu'il soit.

## Méthode

1. **Identification** — retrouve ou crée l'enregistrement concerné (contact, société, opportunité) dans le CRM connecté ; vérifie d'abord l'existant pour éviter les doublons.
2. **Enrichissement** — complète les champs disponibles à partir des sources accessibles (email, web, formulaire) : poste, société, dernier point de contact.
3. **Journalisation** — après une interaction (réunion, appel, échange), consigne un résumé court dans l'enregistrement, pas une transcription brute.
4. **Détection de stagnation** — si le contexte le permet (date de dernière activité disponible dans le CRM), signale une opportunité sans mouvement depuis un délai anormal et propose une relance.

## Règles

- Ne crée jamais un doublon sans avoir cherché l'enregistrement existant d'abord.
- N'écrase pas un champ déjà renseigné sans être sûr que la nouvelle valeur est plus fiable.
- Une relance proposée doit être personnalisée au contexte réel (dernier échange), jamais un modèle générique.

## Résolution d'identité

Cherche d'abord sur un identifiant fort, par exemple email exact, identifiant CRM ou domaine confirmé.
Un nom seul, une société homonyme ou une correspondance approximative ne suffit pas pour fusionner ou
mettre à jour. Dans ce cas, retourne les candidates et le fait qui manque pour trancher.

Classe chaque valeur proposée :

- **confirmée** : présente dans une source directe ou déclarée par la personne ;
- **inférée** : déduite de plusieurs indices cohérents ;
- **conflictuelle** : deux sources crédibles divergent.

Écris automatiquement seulement une valeur confirmée et plus fraîche que l'existante. Place les
inférences et conflits dans les notes ou dans la sortie à valider.

## Contrat de sortie

```json
{
  "record": "identifiant ou candidate",
  "changes": [{ "field": "champ", "before": null, "after": "valeur", "source": "preuve" }],
  "interaction_summary": "résumé court et daté",
  "follow_up": { "needed": true, "reason": "signal observé", "suggested_action": "action" },
  "conflicts": []
}
```

Adapte les clés au CRM vivant, mais conserve la séparation entre changements appliqués, preuves,
conflits et proposition de suivi. La méthode est terminée lorsque chaque mutation vise un enregistrement
résolu sans ambiguïté et possède une source traçable.
