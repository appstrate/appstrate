# Revue de code structurée

## Objectif

Revoir un changement de code et produire un retour actionnable, catégorisé par sévérité, pas un jugement global.

## Méthode

1. **Lecture** — comprends l'intention du changement (description de la PR, ticket lié si disponible) avant de juger le code.
2. **Analyse** — repère : bugs probables, risques de sécurité, régressions, incohérences avec les conventions du projet, opportunités de simplification. Ignore le style pur si un linter/formatter existe déjà.
3. **Restitution** — commentaires groupés par sévérité (bloquant / à corriger / suggestion), chacun localisé (fichier/ligne) avec la raison, pas juste « change ça ».

## Règles

- Un commentaire sans explication du risque concret n'est pas utile — dis toujours ce qui casse et dans quel scénario.
- Ne bloque pas sur des préférences de style si aucune convention du projet ne les impose.
- Signale explicitement l'absence de tests sur un changement à risque, sans l'inventer.

## Deux passes obligatoires

Effectue deux lectures distinctes afin de ne pas confondre conformité et utilité :

1. **Contrat** : le changement satisfait-il la demande, y compris les cas limites et les preuves attendues ?
2. **Standards** : respecte-t-il les règles explicites du dépôt et les frontières des modules touchés ?

Une règle de dépôt n'est bloquante que si elle est écrite ou démontrée par une convention stable. Une
préférence personnelle reste une suggestion.

## Sévérité

- **Bloquant** : corruption, faille, perte de données, contrat principal faux ou déploiement impossible.
- **À corriger** : comportement incorrect dans un scénario réaliste, régression ou dette qui rend la
  prochaine modification dangereuse.
- **Suggestion** : simplification utile sans défaut observable aujourd'hui.

Chaque finding suit ce patron : `sévérité`, `fichier:ligne`, scénario reproductible, conséquence,
correction minimale. Si aucun finding ne survit à ce test, dis explicitement que la revue n'en a pas.

## Contrat de sortie

```text
Verdict : prêt | changements requis

Bloquants
- [fichier:ligne] Scénario, conséquence, correction.

À corriger
- ...

Preuves vérifiées
- tests exécutés ;
- surfaces non testées et raison.
```

La revue est terminée lorsque chaque fichier modifié a été relié au besoin, chaque finding décrit un
échec concret et les vérifications réellement exécutées sont distinguées des suppositions.
