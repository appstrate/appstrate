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
   correspondance garantie avec la reprojection des `parts` persistées : une reprise après
   dépassement garde dans la session l'entrée de l'assistant en échec (masquée par une
   `context_edit`), Pi synthétise des résultats pour les appels d'outils orphelins, et les
   messages `system`/`custom` du tour n'ont pas de `part`. Un rang calculé en direct pourrait donc
   désigner, au tour suivant, un autre message sans que rien ne le signale.
   - Coût : quand Pi coupe après le message utilisateur du tour, le tour suivant reprojette tout
     le tour, donc plus que ce que Pi avait gardé, et peut repasser le seuil plus tôt. Au plus un
     résumé de plus par compaction coupée dans un tour (ce résumé-là coupe dans l'historique
     projeté, qui se traduit exactement), jamais un par message. Quand Pi coupe au message
     utilisateur lui-même, l'ancre est exacte.
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
- Un résumé dont l'ancre n'est pas sur la branche, ou dont `offset` dépasse la projection de son
  message (`resolveSummaryCheckpoint` projette le seul message d'ancre pour le savoir), est
  ignoré avec `logger.warn` ; la recherche continue vers un résumé plus ancien, sinon projection
  complète. `buildStructuredPiTurn` reçoit un point de reprise déjà validé et ne redécide rien :
  les images chargées avant correspondent à ce qui est projeté.
- Mesure d'un tour qui a résumé après sa dernière réponse (le résumé de seuil de Pi tourne
  après la réponse, `_handlePostAgentRun` → `_checkCompaction`) : `context.tokens` prend
  `result.estimatedTokensAfter`, l'estimation de Pi du contexte après le résumé, et non l'usage
  du dernier appel, mesuré avant. Pi la calcule en caractères/4 sur la projection de la session,
  message `system` du tour compris (prompt système), donc sans plancher supplémentaire. Un appel
  abouti après le résumé (résumé d'avant requête ou de dépassement) remet l'usage réel.
  - Exception : quand Pi a coupé dans le tour en cours (ancre repliée sur son message
    utilisateur, décision 3), son estimation ne compte que la part du tour qu'il a gardée, alors
    que le tour suivant renvoie tout le tour. `context.tokens` est alors estimé par le moteur :
    prompt système + résumé + toutes les entrées du tour (`TurnAnchors.estimateRestart`).
- `offset` = rang dans la projection d'un `UIMessage` (un message utilisateur : 0 ; un assistant :
  un message par étape, plus les résultats d'outils, dans l'ordre).
- Horodatage : après `appendCompaction`, la reconstruction relit l'horodatage `t` de l'entrée et
  restampe tous les messages suivants à `t + 1`, un seul horodatage (l'ordre vient de l'arbre
  d'entrées). `t + 1 + i` les aurait poussés de N ms dans le futur : un résumé fait pendant le
  tour, horodaté `new Date()`, aurait pu être plus ancien qu'eux et laisser Pi lire leur usage
  périmé (`agent-session.js` ~2593).

Ajout d'export dans `@appstrate/core` : entrée au CHANGELOG sous `[Unreleased]`.

### Capture (`ui-stream-mapper.ts`, `pi-turn-closure.ts`)

- `compaction_end` non interrompu avec `result` : conserver `result` (le dernier gagne ; une
  seconde compaction dans le même tour part de la première et la remplace).
- `PiChatResultMeta.compacted` devient `compaction?: { summary, firstKeptEntryId, tokensBefore }`.
- `turnContextOf` reçoit la table de correspondance (ci-dessous) et traduit
  `firstKeptEntryId` en `keptFrom`. Identifiant absent de la table : entrée du tour en cours,
  donc ancre sur `branchHeadId`.
- Tranché : la mesure (`turn.context`) et le point de reprise (`turn.summary`) sont séparés. Un
  tour qui a résumé puis échoué sans appel abouti écrit quand même son point de reprise, ce qui
  évite de repayer le résumé après un échec fournisseur.

### Projection (`structured-session.ts`)

- `buildStructuredPiTurn` cherche, en remontant la branche, le tour le plus récent qui porte
  `turn.summary` et dont l'ancre se trouve sur la branche, à sa position ou avant.
  Ancre introuvable ou `offset` hors de la projection de son message : point de reprise ignoré
  avec `logger.warn`, recherche d'un plus ancien, sinon projection complète.
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
  Vocabulaire : « résumé », côté chat comme côté runs.

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
Cette propriété sur deux tours réels est vérifiée par l'E2E navigateur, pas par un test
unitaire : les tests unitaires fixent chaque maillon (capture, projection, reconstruction,
garde d'horodatage de Pi) séparément.

## Lot 2 : usage compté par appel

- En mode abonnement, le moteur observe le résultat de chaque appel fournisseur sur le
  `ModelRuntime` du tour. Le tarif par palier s'applique individuellement, y compris aux deux
  appels d'un résumé coupé au milieu du tour et aux réponses tronquées.
- Le moteur écrit une ligne pour le tour dès que ses appels ont livré leur usage, même après un
  échec ou un arrêt. Ce traitement est indépendant de la fermeture du flux et du point de reprise.
  Un cumul nul ne produit aucune ligne.
- Pas de double compte : une liaison inline (`createPiOAuthModelBinding`) appelle le fournisseur
  sur `model.baseUrl` et ne passe jamais par llm-proxy ; seule la liaison proxy, qui n'écrit rien
  elle-même, y passe. L'appel de résumé emprunte la même fonction de flux que les appels normaux,
  donc llm-proxy le compte déjà en mode proxy.
- Les deux modes donnent maintenant au panneau Infos (`loadSessionUsage`, somme des lignes
  `llm_usage` de la conversation) le même total, résumé compris.
- Ligne inline écrite après le signal de la conversation : `recordTurnUsage` (`chat-stream.ts`)
  écrit sans retenir le flux, puis émet `chat_session_update` (`notifySessionUpdate`) une fois la
  ligne enregistrée, pour une conversation persistée seulement. Le détail (`loadSessionUsage`) est
  relu sur ce signal. Limite : si l'écriture directe échoue et part dans la file de reprise, le
  signal précède la ligne.
- Mode proxy, non modifié : llm-proxy écrit la ligne depuis l'écoute SSE, hors du flux client, à
  la fin de la réponse amont ; le signal de persistance vient après la fermeture du tour (drain de
  persistance, fermeture MCP comprise). L'ordre n'est donc pas garanti mais la ligne précède en
  pratique. Un signal là-bas partirait à chaque appel (relecture du détail en plein tour) et
  ferait émettre un canal du module de chat par le cœur de l'API.

## Lot 3 : réserve de réponse

Plafond absolu de 64k (`RESERVE_CEILING_TOKENS`) sur la réserve. pi-ai borne le `max_tokens`
envoyé à `fenêtre − entrée estimée − marge`, avec un plancher d'environ 32k, sur toutes les formes
d'API : la réserve n'a pas à couvrir la sortie maximale du modèle. La sortie de l'appel de résumé
n'est pas dimensionnée par la réserve.

Limite connue : quand la marge de 15 % de pi-ai ne laisse plus 32 768 tokens de sortie, pi-ai
garde une marge de 4 096 et borne la réponse à 32 768. Sur une fenêtre au-delà d'environ 272k,
c'est le cas près du seuil ; la reprise sur dépassement de Pi (résumé puis nouvel essai) est le
filet. 64k reste dans l'ordre de Claude Code (~33k) et d'OpenCode (`min(sortie, 32k)`).

## Ordre et découpage

Tout est livré dans cette branche : lots 1 à 3 et l'affichage. Le lot 1 supprime le coût
récurrent ; le lot 2 rend mesurable ce qu'il reste ; le lot 3 change un seuil.

Le lot 1 change la forme des métadonnées de tour lues par le navigateur : API et interface
partent dans la même version, sans déploiement progressif.

## Hors périmètre

La compaction côté fournisseur (Anthropic `compact_20260112`, Responses API), spécifique à
chaque API.

Les points « Affichage » et « À envisager » de #2324 sont traités dans cette branche (voir
« Affichage » ci-dessous).

## Affichage

- Le modèle qui a pris la mesure suit ses seuils exacts. Pour un autre modèle, le sélecteur et
  le texte de la jauge avertissent d'un dépassement à partir de 5 % au-dessus du seuil ou de la
  fenêtre déclarée. La jauge affiche la mesure du premier modèle avec « ≈ ».
- La mesure de la conversation est lue une fois (`ConversationContextProvider`) et ne change qu'à
  la fin d'un tour, pas à chaque fragment streamé.
- Pourcentage du seuil non borné au-delà (150 %), arrondi par défaut en dessous ; anneau et barre
  restent bornés.
- Avertissement du brouillon : texte (caractères / 4) et pièces jointes, estimation présentée
  comme telle, région `role="status"` toujours montée. Plafonds partagés avec le moteur
  (`attachment-limits.ts`).
- Fenêtre supposée (`windowAssumed` côté chat, `contextWindowAssumed` côté runs) : une seule règle,
  `resolvePiContextWindow` (`runner-pi/pi-model.ts`), marquée « ≈ » et expliquée (jauge du chat,
  panneau Infos, jauge du run en popover).
- Nombres localisés : `formatCompactTokens(tokens, lang)` et `formatTokenFigure(tokens,
approximate, lang)` (`packages/ui/src/context-window.ts`), un formateur `Intl` par langue.
- Note par modèle dans le sélecteur (`ModelPickerList.renderNote`) : seuil franchi, ou fenêtre
  déjà dépassée (le modèle ne pourra sans doute pas prendre la conversation, même résumée : Pi
  envoie tout l'historique à résumer en un seul appel).
