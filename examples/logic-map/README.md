# Cartes de logique écrites à la main (volet 2, PR 3)

Deux `logic_map` écrites **à la main**, une par famille de prompts (§4.2 du brief
`satellites/internal-docs/proposals/brief-cartographie-visuelle-agents.md`). Aucun LLM
d'inférence, aucun agent cartographe, aucun code de rendu : le but est d'éprouver le format
sur du réel **avant** de l'automatiser.

| Fichier | Famille | Source lue | Étapes | Arêtes | Grappes |
|---|---|---|---|---|---|
| `compta-gmail-harvest.logic-map.json` | `sequence` | `prompt.md` (79 l.) + `SKILL.md` + 2 fichiers de références du skill | 38 | 32 | 8 |
| `fleet-executive-assistant.logic-map.json` | `policies` | `AGENT.md` (243 l.) | 54 | 6 | 14 |

Le contraste est déjà une mesure : 32 arêtes pour 38 étapes d'un côté, 6 pour 54 de l'autre.
Le second graphe est presque entièrement non connexe, et c'est normal, pas une anomalie.

Répartition par type :

- séquence : 15 `step`, 7 `tool_call`, 7 `guard`, 6 `decision`, 2 `loop`, 1 `emit`, 0 `policy`
- politiques : 32 `policy`, 9 `guard`, 5 `decision`, 4 `step`, 4 `tool_call`, 0 `loop`, 0 `emit`

Les deux types absents de chaque colonne sont exactement les types que l'autre famille
sature. Le vocabulaire fermé sépare correctement les deux familles.

## Écarts assumés par rapport au format §4.4

Ces cinq écarts sont le résultat de l'exercice, pas des libertés. Ils sont à intégrer au
JSON Schema de la PR 4.

1. **`refs: []` remplace `ref` (scalaire).** Une étape référence régulièrement deux nœuds à
   la fois : « uploader à la racine de l'Inbox » porte `toolbox:@tractr/google-drive` **et**
   `config:drive_inbox_folder_id` ; « `since` ET `until` sont-ils fournis ? » porte deux
   champs d'entrée. Avec un scalaire, il faut choisir, et le croisement perd la moitié de sa
   matière. 10 des 38 étapes du cas 1 portent 2 refs ou plus.
2. **`edges` est l'unique source de vérité, `branches` n'est pas utilisé.** Le §4.4 propose
   les deux : `branches[{condition,to}]` sur la décision et `edges[{from,to,condition}]` à la
   racine. Deux représentations d'une même arête divergent au premier producteur distrait, et
   le rendu doit lire deux endroits. Une arête conditionnelle est une arête qui porte une
   condition, rien de plus.
3. **`group` (chaîne libre) ajouté.** Le §4.2 dit « grappes groupées par domaine » et le §4.8
   « colonnes de règles groupées par domaine », mais aucun champ ne porte ce domaine. Sans
   lui, le rendu du cas 2 n'a aucun moyen de placer 54 nœuds. `parent` ne peut pas jouer ce
   rôle, voir plus bas.
4. **Le grain outil dans les refs du toolbox : `toolbox:<package>#<outil>`.** Le vocabulaire
   §4.5 s'arrête au package, alors que les prompts raisonnent à l'outil
   (`google_calendar_list_events_for_date`) et que le manifeste déclare `tools[]` par
   intégration. Sans le grain outil, le constat « le prompt appelle un outil que
   `integrations_configuration.tools[]` n'autorise pas » est inexprimable.
5. **`generator.kind`.** Le format suppose un producteur machine (`agent`, `version`,
   `model`). Une carte écrite à la main doit pouvoir le dire, sinon le mode balayage la
   régénérera comme une carte périmée.

## Limites constatées et **non** comblées ici

Trois manques réels, laissés ouverts pour ne pas inventer plus que nécessaire.

1. **Un `guard` n'a pas de portée.** `dry_run` (cas 1, `g3`) n'est pas une étape : c'est un
   mode qui neutralise les effets de bord de trois étapes précises et en laisse neuf
   s'exécuter. Écrit en `guard`, il flotte à côté du graphe sans dire ce qu'il modifie. Il
   manque un `applies_to: [step_id]` sur `guard`, ou un type dédié.
2. **`evidence` est singulier, la règle est parfois répartie.** « Calculer les bornes du
   trimestre fiscal » est prescrite par le prompt (l. 18-19) *et* définie par
   `fiscal-year.md` (l. 33-37). Une seule citation est possible : celle qui fait foi. Le lien
   avec le passage du prompt qui délègue est perdu. `evidence` devrait être un tableau.
3. **Une table de décision devient un seul nœud.** Le tableau « reminder policy » du cas 2
   (5 types d'événement → 5 politiques) est écrasé dans un `policy` unique avec un `detail`
   de cinq phrases. L'exploser en 5 nœuds sans lien serait pire.

## Croisement §4.5, exécuté à la main

Refs de la carte confrontées aux déclarations du manifeste, sans LLM et sans recherche
textuelle.

### `compta-gmail-harvest`

| Constat | Sévérité | Vérifié |
|---|---|---|
| `toolbox:@tractr/google-drive` référencé, non déclaré | erreur | **Vrai.** Le prompt (l. 12) et `gmail-harvest-rules.md` (l. 100) nomment `@tractr/google-drive` ; le manifeste déclare `@appstrate/google-drive`. Identifiant de package obsolète dans la documentation de l'agent |
| `@appstrate/google-drive` déclarée, jamais référencée | indice | Même cause que la ligne précédente, vue de l'autre côté |
| `log` et `pin` accordés, jamais référencés | indice | **Vrai.** Aucune règle nulle part ne dit quand les utiliser. Signal connu du §4.5, confirmé par la lecture de sens |
| `output.schema` déclaré, une étape `emit` présente | — | Aucun avertissement. Le prompt invoque l'outil `output` sans jamais le nommer (« Renseigne `summary`, … ») : le cartographe le rattache par le sens, là où une recherche de sous-chaîne concluait à tort à l'absence |

Couverture complète par ailleurs : 5 champs d'entrée sur 5, 7 champs de sortie sur 7, 2 clés
de configuration sur 2, 1 skill sur 1.

### `executive-assistant`

| Constat | Sévérité | Vérifié |
|---|---|---|
| 10 outils déclarés sur 21 jamais référencés | indice | **Vrai, et pas une anomalie.** `gmail_send_email`, `gmail_draft_email`, `gmail_get_thread`, les trois outils de label, `google_calendar_get_event`, `read_url_content`, `slack_read_thread_messages` : le prompt décrit *quand* rédiger un email sans jamais dire *avec quel outil* |
| `system_tools:message_user` référencé, non déclaré | erreur | **Faux positif.** `message_user` est un outil de plateforme Fleet, documenté à part (l. 222) et absent de la liste des 21. Le constat est artefact d'une source de déclaration incomplète, pas d'un défaut du prompt |
| `calendar_context` : sous-agent déclaré, aucune ref | indice | **Faux positif.** C'est la capacité la plus sollicitée du document (4 règles la mobilisent), mais aucun type de `ref` ne désigne un sous-agent |
| Cron « Daily calendar and email brief » déclaré, aucune règle | *non prévu* | **Vrai.** Voir ci-dessous |

Mesure de la lecture de sens : une recherche de sous-chaîne sur le prompt système ne trouve
que **6 des 21 outils** nommés littéralement (`google_calendar_list_events_for_date`,
`tavily_web_search`, `tavily_linkedin_search`, et les trois outils Slack). La carte en
rattache **11** : les 5 autres (marquer lu, archiver, créer, modifier et supprimer un
événement) sont désignés par leur effet, jamais par leur nom. C'est exactement l'écart que
le §4.5 annonce entre un grep et un cartographe.

### Un cinquième constat, absent du tableau §4.5

**Une planification déclarée qu'aucune règle du prompt ne couvre.** La carte de dépendances
de `executive-assistant` porte un cron quotidien nommé « Daily calendar and email brief » et
la fiche produit en fait un argument de vente. Le prompt système ne décrit ce brief nulle
part : ni contenu, ni format, ni destinataire. La seule mention d'un run cron est incidente,
pour dire que le texte brut n'y est pas affiché.

C'est le croisement le plus fort des deux cartes, parce qu'il porte sur ce que l'agent est
censé faire tous les jours à 16 h. Sévérité proposée : **avertissement**, même famille que
« `output.schema` déclaré mais aucune étape `emit` ».

## Périmètre de lecture

Le §4.3 est confirmé sur les deux familles, dans les deux sens :

- Cas 1 : **14 des 38 étapes** citent un fichier de références du skill (13 `gmail-harvest-rules.md`, 1 `fiscal-year.md`), pas le prompt. Un
  cartographe qui ne lirait que `prompt.md` produirait une coquille : la règle Stripe, les
  filtres anti-bruit, la dédup md5 et la règle de collision de nom n'y sont pas.
- Cas 1 : `SKILL.md` est dans `source.files` mais **aucune étape ne le cite**. Le périmètre
  de lecture est plus large que les sources citées, et c'est normal.
- Cas 2 : deux skills font autorité sur des décisions absentes du prompt (`inbox-triage`
  porte les catégories de triage, `email-drafting` porte les conventions de rédaction). Le
  cas s'observe donc aussi chez Fleet, pas seulement sur les agents Tractr.

## Ce que ces fichiers ne sont pas

Ni schéma, ni fixture de test, ni sortie d'agent. Ce sont les deux cas de référence sur
lesquels le JSON Schema (PR 4), le croisement (PR 5) et le rendu (PR 6) doivent tomber juste.
`integrity` est `null` : ces cartes ne sont attachées à aucune version publiée.
