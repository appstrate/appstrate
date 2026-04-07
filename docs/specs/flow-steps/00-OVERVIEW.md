# Flow Steps — Spécification technique

> Pipeline séquentielle avec branchement logique pour les flows Appstrate

**Date** : 2026-04-06
**Statut** : Draft
**Auteur** : Arthur Cougé
**Prérequis** : AFPS 1.0, SPEC_ROADMAP.md, CLAUDE.md (appstrate)

---

## Résumé

Cette feature permet de composer un flow comme une **pipeline d'étapes séquentielles**, chacune avec :
- Son propre prompt (`.md`)
- Ses propres providers (sous-ensemble du flow parent)
- Ses propres skills et tools
- Son propre modèle IA (optionnel — override ou héritage du flow)
- Un schema d'output typé
- Des conditions de branchement (`routing`) pour skip, goto, ou stop

Un flow sans `steps` reste inchangé (rétrocompatibilité totale).

## Principes directeurs

1. **Rétrocompatibilité** — Les flows existants sans `steps` fonctionnent identiquement
2. **AFPS-native** — Le format est déclaratif dans le manifest, pas dans du code
3. **Moindre privilège** — Chaque step n'accède qu'à ses propres providers
4. **N containers séquentiels** — Réutilise `PiAdapter` tel quel, un container par step
5. **Observabilité** — Logs, SSE, et coûts granulaires par step
6. **Simplicité first** — Séquentiel d'abord, branchement ensuite

## Documents de phase

| Phase | Document | Description | Effort estimé |
|-------|----------|-------------|---------------|
| P1 | [01-MANIFEST-SCHEMA.md](./01-MANIFEST-SCHEMA.md) | Extension du manifest AFPS + validation + ZIP structure | ~2j |
| P2 | [02-STEP-EXECUTOR.md](./02-STEP-EXECUTOR.md) | Service d'exécution séquentielle (sans routing) | ~3j |
| P3 | [03-ROUTING-ENGINE.md](./03-ROUTING-ENGINE.md) | Branchement conditionnel + stop anticipé | ~2j |
| P4 | [04-DATABASE-OBSERVABILITY.md](./04-DATABASE-OBSERVABILITY.md) | Table `execution_steps` + logs groupés + SSE | ~2j |
| P5 | [05-FRONTEND-PIPELINE.md](./05-FRONTEND-PIPELINE.md) | Vue pipeline + logs par step + output intermédiaire | ~3j |
| P6 | [06-EDITOR-UX.md](./06-EDITOR-UX.md) | Éditeur de steps (ajout, suppression, reorder, conditions) | ~5j |

## Dépendances entre phases

```
P1 ──→ P2 ──→ P3
       │
       └──→ P4 ──→ P5 ──→ P6
```

P1 est le socle (schema). P2 et P4 sont indépendants l'un de l'autre mais dépendent de P1. P3 dépend de P2. P5 dépend de P4. P6 dépend de P5.
