---
name: triage-sentiment
description: Classe les tickets ou messages entrants par urgence/sentiment/catégorie, propose une réponse depuis la base de connaissance quand c'est possible, escalade sinon. Charge cette skill pour tout agent de support/triage sur des tickets, emails ou messages.
---

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
- Jamais d'envoi automatique de réponse — brouillon à valider, sauf si l'agent est explicitement configuré pour de la FAQ pure sans ambiguïté.
