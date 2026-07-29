---
name: logic-map-tools
description: Contrôles déterministes d'une carte de logique, à exécuter AVANT de la rendre. Vérifie que chaque citation existe réellement dans la source aux lignes annoncées, et que le format est valide. Aucun appel de modèle — comparaison de chaînes et validation de schéma.
---

# Outils de carte de logique

**Pas de logique de modèle ici.** Deux contrôles déterministes, à lancer en bash depuis
le runtime de l'agent, avant l'appel à `output`.

## Pourquoi ces contrôles vivent ici et pas dans la plateforme

Ils lisent **les fichiers du bundle** : le prompt, les `SKILL.md` des skills déclarés et
leurs fichiers de références. Ces fichiers ne sont montés que pendant le run. Une fois la
carte publiée, plus personne ne peut vérifier qu'elle cite juste — la plateforme relit la
carte, jamais les sources.

C'est aussi le seul moment où la vérification a un sens : une carte qui cite mal est pire
qu'une carte absente, puisqu'elle a l'apparence de la preuve. Mieux vaut ne rien rendre
que rendre une carte dont l'ancrage ment.

## `scripts/verify-evidence.ts` — la vérification des citations

```bash
bun .pi/skills/@appstrate/logic-map-tools/scripts/verify-evidence.ts <carte.json> <racine>
```

`<racine>` est le répertoire depuis lequel les chemins de `evidence.file` se résolvent,
c'est-à-dire la racine du bundle lu.

Pour chaque étape, le script relit le fichier cité et cherche la citation dans la fenêtre
de lignes annoncée. Il distingue trois échecs, et chacun dit une chose différente :

| Résultat           | Ce que ça signifie                                | Quoi faire                                                                          |
| ------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **INTROUVABLE**    | la citation n'existe nulle part dans le fichier   | l'étape est inventée, ou la citation a été reformulée. **Corriger avant de rendre** |
| **MAL SITUÉE**     | la citation existe, mais pas aux lignes annoncées | le clic renverra le lecteur au mauvais endroit. Corriger les lignes                 |
| **ILLISIBLE**      | le fichier cité n'existe pas                      | mauvais chemin, ou fichier hors du bundle                                           |
| **HORS PÉRIMÈTRE** | le fichier n'est pas dans `source.files`          | la carte ne déclare pas avoir lu ce fichier : compléter `source.files`              |

Le script sort en code 1 dès qu'un de ces cas se présente.

**Piège mesuré** : une citation à trous (`« Renseigne summary (…), window »`) est
**introuvable**, parce qu'elle ne correspond à aucun passage contigu. C'est voulu — une
citation élidée n'est pas vérifiable, donc `quote` doit toujours être un extrait
**contigu**, quitte à être plus court.

La normalisation tolère les différences d'espacement et la ponctuation décorative
(backticks, astérisques markdown, guillemets typographiques), parce qu'elles ne changent
pas ce que la source prescrit. Elle ne tolère ni élision ni reformulation.

## Validation du format

La plateforme valide déjà la sortie contre `output.schema` avant de la persister : une
carte mal formée est refusée sans qu'on ait rien à écrire. Ce skill n'a donc **pas** de
script de validation de schéma — ce serait un doublon de ce qu'AJV fait gratuitement.

Ce que le schéma ne dit pas, en revanche, et qu'il faut relire soi-même :

- une arête dont `from` ou `to` ne désigne aucune étape existante ;
- un `parent` qui pointe vers une étape absente ;
- une étape sans aucune arête dans une carte déclarée `sequence` (souvent un oubli).

## Ordre d'invocation

1. produire la carte ;
2. `verify-evidence.ts` sur la carte et la racine du bundle ;
3. corriger ce qui remonte, puis revérifier ;
4. seulement ensuite, appeler `output`.
