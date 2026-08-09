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

## Normalisation

Fixe la fenêtre en dates exactes et le périmètre en équipe, projet ou sprint. Relie une pull request à
son ticket quand une référence stable existe afin de ne pas compter deux fois le même résultat. Un
ticket fermé mesure une activité, pas nécessairement un impact livré. Décris l'impact seulement
lorsque la source permet de le relier à un utilisateur, une métrique ou un objectif.

Classe un item :

- **fait** si la source confirme son état terminal dans la fenêtre ;
- **en cours** si une activité ou un état courant le confirme ;
- **bloqué** seulement si un blocage ou une dépendance est explicitement signalé ;
- **à clarifier** si les sources divergent ou sont trop anciennes.

## Contrat de sortie

```text
Périmètre : équipe, projet, période, sources consultées
Résultats livrés : résultat, impact connu, références
En cours : prochaine étape et responsable connu
Blocages : cause, durée, décision ou aide attendue
Risques et écarts : objectif concerné, preuve
Prochaine période : trois priorités maximum
```

Ajoute des comptes par statut seulement si le périmètre et la déduplication sont fiables. La méthode
est terminée lorsque chaque item du rapport possède une référence source, aucun travail n'est compté
deux fois et les blocages sont séparés des simples absences d'activité.
