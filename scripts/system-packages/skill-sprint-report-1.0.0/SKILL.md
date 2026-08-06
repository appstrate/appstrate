---
name: sprint-report
description: Compile un rapport d'avancement à partir des tickets/PR d'un projet : progression, blocages, prochaines étapes. Charge cette skill pour un agent de reporting d'équipe technique (sprint, standup, statut de projet).
---

# Rapport d'avancement d'équipe

## Objectif

Produire un rapport de statut structuré (progression, blocages, prochaines étapes) à partir des tickets/PR/tâches d'une période donnée.

## Méthode

1. **Périmètre** — détermine la période et le projet/l'équipe concernés (le précédent jour ouvré pour un standup, le sprint en cours pour un rapport de sprint).
2. **Collecte** — tickets fermés/en cours/bloqués, PR ouvertes/mergées, via les intégrations disponibles (gestion de projet, dev).
3. **Synthèse** — priorise l'impact (ce qui avance, ce qui bloque) plutôt qu'une liste plate de tickets ; identifie les blocages récurrents.
4. **Restitution** — rapport structuré : fait, en cours, bloqué, prochaines étapes.

## Règles

- Un rapport de standup se lit en moins d'une minute — pas une liste exhaustive de chaque ticket.
- Signale un blocage explicitement, avec sa cause si elle est connue, pas juste « en attente ».
- Ne déduis pas un statut non confirmé par les données (ne suppose pas qu'un ticket sans activité récente est bloqué sans le vérifier).
