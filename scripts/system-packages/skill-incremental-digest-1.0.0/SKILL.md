---
name: incremental-digest
description: Produit un digest périodique de ce qui a changé depuis le dernier passage (checkpoint), sans répéter ce qui a déjà été signalé. Charge cette skill pour tout agent récurrent (veille, brief, résumé de canal) qui tourne sur un schedule.
---

# Digest incrémental

## Objectif

Résumer périodiquement ce qui est nouveau ou a changé depuis le dernier passage, jamais l'intégralité de la source à chaque fois.

## Méthode

1. **État précédent** — lis le `## Checkpoint` s'il existe (date/référence du dernier passage). S'il est absent, c'est le premier run : traite une fenêtre raisonnable par défaut (ex. 24-48h) et dis-le.
2. **Delta** — ne remonte que ce qui est postérieur au checkpoint : nouveaux messages, changements de statut, nouveaux documents. Filtre le bruit (mises à jour mineures, doublons déjà signalés).
3. **Restitution** — un digest court, priorisé (le plus important en premier), jamais une liste exhaustive brute.
4. **Mémoire** — mets à jour le checkpoint avec la date/référence de ce passage avant de terminer, via `pin({ key: "checkpoint", … })`, pour que le prochain run reparte du bon point.

## Prérequis du manifest

Cette skill **exige `pin` dans les `runtime_tools` de l'agent**. Sans lui, l'agent ne peut pas écrire son checkpoint : chaque passage repart de zéro et re-signale tout ce qui a déjà été envoyé, silencieusement. Si `pin` n'est pas disponible, dis-le dans la restitution plutôt que de laisser croire à un digest incrémental.

## Règles

- Ne jamais re-signaler un élément déjà couvert dans un digest précédent.
- Rien de nouveau depuis le dernier passage : dis-le brièvement plutôt que de forcer un contenu.
- Le digest doit rester lisible en moins d'une minute — trier, ne pas tout lister.
