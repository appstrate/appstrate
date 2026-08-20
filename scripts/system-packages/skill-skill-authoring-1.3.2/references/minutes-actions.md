# Synthèse de réunion en décisions et actions

## Objectif

À partir d'un transcript ou de notes de réunion, produire une synthèse exploitable : un résumé court, les décisions réellement actées, et les actions à suivre avec responsable et échéance quand ils sont nommés.

## Méthode

1. **Contexte** — si un `## Checkpoint` est injecté, il contient la synthèse de la réunion précédente du même type (sujets récurrents, actions encore ouvertes) : utilise-le, ne le redemande pas.
2. **Analyse** — distingue :
   - les **décisions** réellement actées (pas les pistes évoquées) ;
   - les **actions** : une tâche, un responsable et une échéance, uniquement s'ils sont explicitement nommés ;
   - les **points d'attention** : désaccords, questions ouvertes, sujets reportés.
3. **Restitution** — structure le résultat selon le schéma déclaré par l'agent (typiquement `resume`, `decisions`, `actions[]`, `points_attention`), puis produis un compte-rendu lisible : résumé, décisions, tableau des actions (Action · Responsable · Échéance), points d'attention.
4. **Mémoire** : si l'agent possède une mémoire durable, enregistre un récapitulatif court avec la date, les sujets et les actions ouvertes pour la prochaine réunion. S'il possède aussi une capacité d'archivage, conserve les décisions structurantes, par exemple un engagement ferme, un budget ou une échéance contractuelle.

## Prérequis sémantiques

Le suivi entre réunions exige une mémoire durable et l'archivage exige une capacité de conservation à long terme. L'agent traduit ces besoins avec les capacités de son contrat courant. Sans elles, produis la synthèse du jour et n'annonce aucun suivi entre réunions.

## Règles

- N'invente jamais un responsable ou une échéance absents du transcript — laisse le champ vide.
- Une action = un verbe d'action + un livrable clair (« Rédiger la spec X », pas « Voir pour X »).
- Transcript vide ou inintelligible : dis-le explicitement plutôt que de combler les trous.

## Tests de classification

Une **décision** comporte un accord ou un choix final, pas seulement une préférence exprimée. Une
**action** comporte un changement futur vérifiable. Une **question ouverte** reste ouverte même si une
option a reçu davantage d'attention pendant l'échange.

Pour chaque élément, conserve une preuve courte avec horodatage ou locuteur si la source le permet.
Un responsable collectif comme « l'équipe » reste collectif. Une échéance relative est normalisée à
partir de la date de réunion seulement lorsque cette date est connue.

## Contrat de sortie

```json
{
  "summary": "résumé en quelques phrases",
  "decisions": [{ "decision": "...", "evidence": "..." }],
  "actions": [
    { "action": "verbe et livrable", "owner": null, "due_date": null, "evidence": "..." }
  ],
  "open_questions": [{ "question": "...", "next_step": null }]
}
```

Déduplique les reformulations d'une même décision ou action. Le compte-rendu est terminé lorsque
chaque item structuré est traçable au transcript, les champs absents restent nuls et les désaccords
ne sont pas transformés en décisions.
