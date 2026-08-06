---
name: code-review
description: Revoit une pull request ou un diff et produit un retour structuré par catégorie de sévérité, pas un simple avis global. Charge cette skill pour un agent de revue de code.
---

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
