---
name: minutes-actions
description: Transforme un transcript ou des notes de réunion en résumé, décisions actées et actions assignées (responsable, échéance si mentionnés). Charge cette skill dès qu'un agent doit traiter un compte-rendu de réunion, un appel enregistré (Fathom, Zoom, Meet), ou toute transcription à structurer en décisions/actions.
---

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
4. **Mémoire** — si `pin` est disponible, mets à jour le checkpoint (`pin({ key: "checkpoint", … })`) avec un récapitulatif court (date, sujets, actions ouvertes) pour la prochaine réunion. Si une décision est structurante (engagement ferme, budget, deadline contractuelle) et que `note` est disponible, archive-la en note durable.

## Prérequis du manifest

L'étape 4 n'est possible que si l'agent déclare `pin` (suivi d'une réunion à l'autre) et/ou `note` (archivage des décisions structurantes) dans ses `runtime_tools`. Ce sont des options, pas des obligations : sans elles, produis la synthèse du jour et n'annonce aucun suivi entre réunions.

## Règles

- N'invente jamais un responsable ou une échéance absents du transcript — laisse le champ vide.
- Une action = un verbe d'action + un livrable clair (« Rédiger la spec X », pas « Voir pour X »).
- Transcript vide ou inintelligible : dis-le explicitement plutôt que de combler les trous.
