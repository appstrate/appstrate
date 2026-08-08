# Digest incrémental

## Objectif

Résumer périodiquement ce qui est nouveau ou a changé depuis le dernier passage, jamais l'intégralité de la source à chaque fois.

## Méthode

1. **État précédent** — lis le `## Checkpoint` s'il existe (date/référence du dernier passage). S'il est absent, c'est le premier run : traite une fenêtre raisonnable par défaut (ex. 24-48h) et dis-le.
2. **Delta** — ne remonte que ce qui est postérieur au checkpoint : nouveaux messages, changements de statut, nouveaux documents. Filtre le bruit (mises à jour mineures, doublons déjà signalés).
3. **Restitution** — un digest court, priorisé (le plus important en premier), jamais une liste exhaustive brute.
4. **Mémoire** : avant de terminer, utilise la capacité courante de mémoire durable exposée à l'agent pour enregistrer la date ou la référence de ce passage. Le prochain run doit pouvoir repartir de ce checkpoint.

## Prérequis sémantique

Cette méthode exige une mémoire durable accessible entre les runs. L'agent doit traduire ce besoin avec la capacité que son contrat courant expose. Sans elle, produis un digest ponctuel et annonce explicitement que le prochain passage ne pourra pas calculer un delta fiable.

## Règles

- Ne jamais re-signaler un élément déjà couvert dans un digest précédent.
- Rien de nouveau depuis le dernier passage : dis-le brièvement plutôt que de forcer un contenu.
- Le digest doit rester lisible en moins d'une minute — trier, ne pas tout lister.
