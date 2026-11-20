# Chat : conserver le résumé de l'historique (#2324)

Plan d'implémentation des trois points « Coût et exactitude » de l'issue #2324.
Établi par lecture de `origin/main` (876985175). Le SDK Pi épinglé est **1.5.2**
(`packages/runner-pi/package.json`) ; les faits ci-dessous ont été relus dans cette version.

## Constat

Chaque tour reconstruit une session Pi jetable depuis l'historique (`reconstructPiSession`).
Quand Pi résume, `ui-stream-mapper.ts` reçoit `compaction_end` avec le résultat complet
(`summary`, `firstKeptEntryId`, `tokensBefore`, `usage`) et n'en garde qu'un booléen.
Au tour suivant, l'historique complet est reprojeté, repasse le seuil, et Pi résume de nouveau.

## Faits vérifiés dans le SDK Pi (1.5.2)

- `SessionManager.appendCompaction(summary, firstKeptEntryId: string | null, tokensBefore, details?,
fromHook?, usage?)` existe et fonctionne sur une session en mémoire. `null` : l'entrée se désigne
  elle-même, le contexte se réduit alors au résumé suivi de ce qui vient après.
- L'entrée de compaction peut figer le message `system` courant de la projection (`systemMessage`)
  et le contexte rend alors `[systemMessage, résumé]`. La reconstruction n'ajoute aucun message
  `system` (le prompt système part par le chargeur de ressources) : rien n'est figé.
- `buildContextEntries` / `buildSessionProjection` rendent : le résumé, puis les entrées de
  `firstKeptEntryId` jusqu'à l'entrée de compaction, puis celles qui la suivent. Les entrées
  antérieures à `firstKeptEntryId` ne partent jamais au modèle : inutile de les projeter.
- `prepareCompaction` (non exporté par l'index du SDK) relit la dernière compaction de la
  projection : il passe son `summary` comme `previousSummary` et ne résume que ce qui la suit.
- `_checkCompaction` ignore un message assistant dont le `timestamp` est antérieur ou égal à celui
  de l'entrée de compaction (`agent-session.js` ~2506 et ~2593). L'entrée est horodatée `new Date()`
  à l'ajout, sans paramètre pour l'imposer.
- `estimateProjectedContextTokens` (contrôle d'avant requête) ne croit l'usage d'un assistant que
  s'il suit, dans la branche, la dernière entrée de compaction ; sinon il réestime tout.
- Pi peut couper au milieu d'un tour (`isSplitTurn`).

## Faits vérifiés côté Appstrate

- L'historique d'un tour vient du navigateur (`chat-stream.ts`, « The client sends its selected
  history branch »), métadonnées comprises. Seul le dernier message est validé.
- Les métadonnées de tour (`AppstrateTurnMetadata`, `@appstrate/core/chat-turn-metadata`) sont
  écrites à chaque sortie de tour, échecs compris, par `closePiTurn`.
- Un `UIMessage` assistant se projette en plusieurs messages Pi (un par étape, plus les
  résultats d'outils). Un message utilisateur en donne un, ou zéro.

## Décisions

1. **Le point de reprise vit dans les métadonnées du tour qui a résumé**, sous
   `turn.summary` (à côté de `turn.context`, pas dedans : un tour qui a résumé puis échoué sans
   appel abouti n'a pas de mesure mais garde son résumé). Pas de table, pas de migration.
   - Il suit la branche : une branche qui part avant ce message ne le voit pas, une
     régénération de ce tour le perd et retombe sur le point précédent.
   - Il fonctionne aussi pour un tour éphémère (sans session).
   - Il fait l'aller-retour par le navigateur, comme le reste de l'historique. Aucune frontière
     de confiance nouvelle : l'historique est déjà fourni par le client.
2. **L'ancre s'exprime en identifiants Appstrate** : `{ messageId, offset }`, `offset` étant le
   rang du message Pi dans la projection de ce `UIMessage`. La projection d'un message persisté
   est déterministe, donc le rang est stable d'un tour à l'autre.
3. **Une coupe dans le tour en cours s'ancre sur le message utilisateur du tour**
   (`branchHeadId`, `offset: 0`). Les entrées produites en direct par Pi n'ont pas de
   correspondance garantie avec la reprojection des `parts` persistées. On garde alors tout le
   tour en cours, ce qui est le comportement attendu pour le contenu le plus récent.
4. **Placement de l'entrée de compaction à la reprojection : juste après la première entrée
   gardée.** Le contexte envoyé est identique quel que soit le placement, et celui-ci laisse
   tous les messages assistants suivants « après la compaction », donc leur usage estimé reste
   lu par le contrôle de seuil d'avant requête.
5. **`compacted?: boolean` disparaît**, remplacé par le point de reprise. Pas de lecture de
   l'ancien champ : un tour ancien qui porte `compacted: true` se lit comme un tour sans point
   de reprise. Aucune réécriture de données.

## Lot 1 : point de reprise

### Type (`packages/core/src/chat-turn-metadata.ts`)

```ts
export interface AppstrateTurnMetadata {
  // …
  context?: AppstrateTurnContext; // tokens, window, compactAt
  summary?: AppstrateTurnSummary;
}

export interface AppstrateTurnSummary {
  text: string;
  keptFrom: { messageId: string; offset: number };
  tokensBefore: number;
}
```

Décisions d'implémentation (lot 1) :

- `turnContextOf` rend `{ context?, summary? }` : le résumé est écrit même sans mesure.
- Un résumé dont l'ancre n'est pas sur la branche (ou dont `offset` dépasse la projection de son
  message) est ignoré avec `logger.warn` ; la recherche continue vers un résumé plus ancien,
  sinon projection complète.
- `offset` = rang dans la projection d'un `UIMessage` (un message utilisateur : 0 ; un assistant :
  un message par étape, plus les résultats d'outils, dans l'ordre).
- Horodatage : après `appendCompaction`, la reconstruction relit l'horodatage de l'entrée et
  restampe chaque message suivant à `t + 1 + i`.

Ajout d'export dans `@appstrate/core` : entrée au CHANGELOG sous `[Unreleased]`.

### Capture (`ui-stream-mapper.ts`, `pi-turn-closure.ts`)

- `compaction_end` non interrompu avec `result` : conserver `result` (le dernier gagne ; une
  seconde compaction dans le même tour part de la première et la remplace).
- `PiChatResultMeta.compacted` devient `compaction?: { summary, firstKeptEntryId, tokensBefore }`.
- `turnContextOf` reçoit la table de correspondance (ci-dessous) et traduit
  `firstKeptEntryId` en `keptFrom`. Identifiant absent de la table : entrée du tour en cours,
  donc ancre sur `branchHeadId`.
- Aujourd'hui `turnContextOf` ne rend rien quand aucun appel n'a abouti. Un tour qui a résumé
  puis échoué doit quand même écrire son point de reprise : séparer la mesure (`tokens`) du
  point de reprise, ou décider que ce cas reste perdu. À trancher à l'implémentation ; la
  première option évite de repayer le résumé après un échec fournisseur.

### Projection (`structured-session.ts`)

- `buildStructuredPiTurn` cherche, en remontant la branche, le tour le plus récent qui porte
  `context.summary` et dont l'ancre se trouve sur la branche, à sa position ou avant.
  Ancre introuvable : point de reprise ignoré, projection complète, `logger.warn`.
- Avec un point de reprise : ne projeter que depuis l'ancre. Les messages antérieurs ne sont
  ni convertis ni estimés, et `loadAttachmentImages` ne lit que les messages projetés.
- La projection rend, pour chaque message Pi, son origine `{ messageId, offset }`.
- Estimation de départ : `baseTokens + estimateTokens(résumé) + messages gardés`.

### Reconstruction (`structured-session.ts`, `engine.ts`)

- `reconstructPiSession` ajoute la première entrée gardée, appelle `appendCompaction` avec son
  identifiant, puis ajoute le reste. Il rend la session et la table `entryId → origine`.
- Horodatage : les messages ajoutés après l'entrée de compaction doivent porter un `timestamp`
  strictement supérieur au sien. L'horloge de projection actuelle part de `Date.now()` avant
  la reconstruction, ce qui ne le garantit pas. La reconstruction relit l'horodatage de l'entrée
  et décale la suite.
- `SessionManagerLike` gagne `appendCompaction` et la lecture de l'entrée ajoutée.

### Jauge (`packages/module-chat/src/ui/turn-context.ts`)

- Retirer la règle « un tour résumé est plein ». Niveau `full` seulement si
  `tokens > compactAt`. Après un résumé, `tokens` est l'usage réel de l'appel qui a suivi : la
  jauge redescend seule.
- Le popover peut indiquer que l'historique antérieur est résumé (présence de `summary`).
  Vocabulaire : « résumé », en attendant le point « Vocabulaire » de l'issue.

### Commentaires à réécrire

En-tête de `structured-session.ts` (« no derived state is reused ») et doc de
`AppstrateTurnContext.compacted` : ils décrivent le comportement supprimé.

### Tests

Unitaires, avec le vrai `SessionManager` de Pi :

- projection avec point de reprise : `buildSessionContext` rend résumé, puis messages gardés,
  dans l'ordre ; rien d'antérieur à l'ancre ;
- ancre au milieu d'un message assistant à plusieurs étapes (`offset > 0`) ;
- branche qui ne contient pas le tour porteur : projection complète ;
- ancre introuvable : projection complète et avertissement ;
- deux points de reprise sur la branche : le plus récent gagne ;
- horodatage : l'usage estimé du dernier assistant projeté est lu par le contrôle de seuil ;
- `prepareCompaction` sur la session reconstruite reçoit `previousSummary` et ne résume que
  l'après-ancre ;
- mapper : résultat capturé, le dernier gagne, compaction interrompue ignorée ;
- traduction d'un `firstKeptEntryId` du tour en cours vers `branchHeadId`.

De bout en bout : modèle d'organisation à petite fenêtre pour franchir le seuil, deux tours.
Le premier résume une fois. Le second ne fait aucun appel de résumé, et sa requête commence
par le résumé du premier. Vérifier aussi le rechargement de la page et la reprise de flux.

## Lot 2 : usage compté par appel

- `ui-stream-mapper.ts` : ajouter `result.usage` de `compaction_end` au cumul du tour
  (`addRequestUsage`), sans toucher `lastSettledUsage` (un résumé n'est pas la mesure du
  contexte).
- `engine.ts` : le bloc `recordUsage` passe dans un chemin commun aux sorties nominale et en
  échec, et n'écrit que si le cumul est non nul.
- Vérifier d'abord que le mode proxy ne compte pas déjà le résumé par ailleurs, pour ne pas le
  compter deux fois : le bloc est gardé par `metering.kind === "inline"`, à confirmer par un
  test dans chaque mode.
- Écriture non attendue de la ligne `llm_usage` : hors lot. La corriger demande de décider si
  la fin de flux attend le registre, ce qui retarde le dernier octet.

Tests : tour en échec après un appel abouti → une ligne ; tour avec résumé → les tokens du
résumé sont dans la ligne ; même total dans les deux modes de facturation.

## Lot 3 : réserve de réponse

Décision à prendre avant d'écrire du code.

- Vérifier quel `max_tokens` part réellement dans la requête pour un modèle à 384k de sortie.
  S'il vaut 384k, baisser la seule réserve fait refuser par le fournisseur toute requête dont
  l'entrée dépasse `fenêtre - 384k`. La réserve et le `max_tokens` envoyé doivent alors baisser
  ensemble.
- Vérifier le plafond de sortie de l'appel de résumé de Pi (`generateSummary` le dérive de
  `reserveTokens`). Une réserve de 384k autoriserait un résumé de plusieurs centaines de
  milliers de tokens.
- `deriveResponseReserveTokens` est partagé avec le sidecar des runs
  (`runtime-pi/sidecar/token-budget.ts`) : tout changement touche les deux surfaces, qui
  doivent rester d'accord.

## Ordre et découpage

Trois PR indépendantes, dans cet ordre : lot 1, lot 2, lot 3. Le lot 1 supprime le coût
récurrent ; le lot 2 rend mesurable ce qu'il reste ; le lot 3 change un seuil et se juge mieux
une fois les deux premiers en place.

Le lot 1 change la forme des métadonnées de tour lues par le navigateur : API et interface
partent dans la même version, sans déploiement progressif.

## Hors périmètre

Les points « Affichage » et « À envisager » de #2324, et la compaction côté fournisseur
(Anthropic `compact_20260112`, Responses API), spécifique à chaque API.
