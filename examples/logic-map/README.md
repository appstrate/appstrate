# Cartes de logique écrites à la main (volet 2, PR 3)

Le jalon éprouve le format `logic_map` (§4.4 du brief
`satellites/internal-docs/proposals/brief-cartographie-visuelle-agents.md`) sur du réel,
**avant** de l'automatiser. Deux cartes de référence ont d'abord été écrites à la main, puis
le corpus a été élargi à 18 cartes couvrant quatre origines indépendantes.

Aucun agent cartographe, aucun schéma, aucun rendu produit : rien que le format, confronté à
des documents que personne n'a écrits pour lui.

## Le corpus

| Origine | Agents | Cartes |
|---|---|---|
| Tractr (`satellites/implantation/tractr`) | compta-gmail-harvest, compta-inbox, compta-trimestrielle, mes-taches-clickup, wiki-brain | 5 |
| Core (`satellites/implantation/core`) | analyste-donnees, synthese-reunion | 2 |
| LangSmith Fleet (benchmark) | executive-assistant, gtm, on-call-copilot, software-engineer, competitor-intelligence, x-content-manager, tavily-research | 7 |
| Agents publics (récupérés à la source, SHA dans `corpus-web/PROVENANCE.md`) | Codex CLI + sa rubrique de revue, OpenHands, un sous-agent Claude Code | 4 |

**18 cartes · 833 nœuds · 766 citations vérifiées mécaniquement.**

Prompts de 16 à 753 lignes. Familles : 9 `sequence`, 9 `policies`, dont 4 hybrides avérés.

## Verdict

**Le format tient.** Les cinq lots concluent dans le même sens : les familles se séparent
sans forcer, `evidence` tient sur des prompts de 750 lignes, `group` et `edges` passent sans
concession, et aucun des sept types n'est inutile. Deux prompts de 296 et 237 lignes ont été
absorbés sans qu'un seul passage soit forcé.

Deux mesures le confirment sans avis humain :

- **99,5 % des 766 citations sont littérales et aux lignes annoncées** (`verify-evidence.mjs`
  relit chaque source). Les quatre échecs sont dans les cartes de référence, et pour une
  seule cause : une citation à trous (« … ») n'est pas vérifiable. D'où la règle : `quote`
  doit être un extrait **contigu**. Ce contrôle attrape mécaniquement une carte inventée,
  c'est le garde-fou dont la PR 7 a besoin.
- **Les 18 cartes passent le contrôle de cohérence interne** (`check.mjs`) : identifiants
  uniques, `parent` existants, arêtes résolues, `evidence` complet.

## Corrections à acter en PR 4, par ordre

Cet ordre n'est pas arbitraire : la première correction en résout quatre à elle seule, et
elle doit précéder la cinquième, qui perdrait sinon son intérêt.

### 1. `applies_to` sur `guard` — bloquant

Un garde-fou s'applique à une classe d'actions ; le format ne peut pas dire laquelle. Quatre
manifestations indépendantes du même trou :

- `dry_run` (compta-gmail-harvest) neutralise trois étapes et en laisse neuf s'exécuter ;
- `wiki-brain` **marque littéralement** ses étapes d'écriture par le mot « Écriture. » en fin
  de ligne : la donnée est écrite, le format ne peut pas la porter ;
- la phase `3. TESTING` d'OpenHands contient six règles qui ne valent qu'à l'intérieur ;
- « All content passes through this » (x-content-manager) désigne un point de passage obligé.

Bénéfice décisif : **le champ manquant est aussi le discriminant manquant.** Un principe
directeur est exactement un garde-fou dont `applies_to` vaudrait « tout », c'est-à-dire rien.
Le tri entre contrainte réelle et posture devient calculable.

### 2. `refs` : trois préfixes manquants

- **`runtime:<capacité>`** — pour `bash`, `Read`, `Edit`, `shell`, `apply_patch`,
  `browser_*` : capacités **natives du runtime**, ni intégration ni outil accordé par le
  manifeste. Mesuré : **12 outils dans ce cas sur 7 cartes**, tous classés « erreur » par le
  croisement, aucun n'étant un vrai défaut. `compta-inbox` et `compta-trimestrielle` en
  dépendent entièrement (tous les scripts du skill passent par bash).
- **`subagents:<nom>`** — manque le plus reproductible du corpus, quatre occurrences
  (`calendar_context`, `CompetitorResearchWorker`, `CompanyResearchWorker`, les scouts de
  `on-call`). Sans lui, le croisement produit un faux positif par sous-agent sur tout le
  catalogue Fleet, alors que c'est souvent la capacité la plus sollicitée du document.
- **`context_files:<motif>`** — `AGENTS.md`, `.cursorrules`, `AGENTS.override.md` : cités par
  8 nœuds de deux cartes. Ni skill, ni configuration, ni outil. Sans ce terme, la relation
  d'autorité la plus structurante des agents de code (qui prime sur qui) reste invisible.

**La sévérité d'une référence non résolue dépend de l'existence d'un emplacement de
déclaration.** C'est la règle qui rend `runtime:` exploitable, et elle se lit sur un même
agent :

- `toolbox:@appstrate/google-drive#api_upload` : un emplacement existe
  (`integrations_configuration.tools[]`), il ne contient que `api_call` → **erreur réelle**,
  et pas marginale, c'est *la* méthode de création de fichier prescrite par `compta-inbox`.
- `runtime:bash`, `runtime:read_file` : **aucun emplacement de déclaration n'existe**
  (`runtime_tools` est le catalogue des outils de plateforme, pas des capacités d'hôte) →
  **indice**, jamais erreur, sinon on remplace un faux négatif par un faux positif.

Corollaire de mise en œuvre : **dédupliquer la sévérité par référence, pas par nœud.** Sur
les cartes compta, `bash` porte 13 nœuds pour un seul défaut ; un croisement naïf sortirait
13 erreurs identiques.

**Le grain doit valoir pour deux autres porteurs :**

- **`mcp_servers:<pkg>#<outil>`** — deux cartographes ont déjà divergé sur le même outil
  Notion, l'un écrivant `toolbox:notion#notion-search`, l'autre `mcp_servers:notion#…`.
- **`skills:<pkg>#scripts/<fichier>`** — sur les deux agents compta, la même paire de
  références couvre 13 nœuds pour **six scripts distincts** (`mc-extractor.ts`,
  `chq-extractor.py`, `extract-pdf.py`, `cc-csv-extractor.py`, `match-factures.py`,
  `generate-xlsx.py`). Le constat « le prompt invoque un script absent de `scripts/` » est
  inexprimable.

### 3. `groups[]` à la racine, avec `shape` et `order`

`shape` racine dit qu'un document mélange les genres, pas **où**. Le point dur n'est pas la
cohabitation entre grappes mais **dans** une grappe : `Codebase Work` de `software-engineer`
contient dix nœuds chaînés **et** quatre hors flot, dont deux posés au milieu de la liste à
puces. Un groupe doit déclarer sa nature et son rang.

Ça supprime aussi un hack : les cartes de référence préfixent leurs noms de groupe par
« 1. », « 2. » pour porter un ordre que le format ne sait pas exprimer.

**`shape: hybrid` a été examiné et écarté** : un troisième scalaire aurait le défaut du
binaire, et donnerait la même étiquette à deux documents opposés — `software-engineer`, où
l'ordre est un détail (24 nœuds sur 40 hors flot), et `competitor-intelligence`, où le
workflow numéroté **est** le contenu.

### 4. `evidence` en tableau — confirmé sept fois

Une règle vit régulièrement à deux endroits (`codex:138` et `:157`, `openhands:38` et `:61`,
`api1` de wiki-brain réparti sur 15 lignes). Une seule citation est possible, l'autre source
est perdue.

Deux corollaires mesurés sur les prompts denses :

- **La ligne ne discrimine plus.** `openhands:110` est une ligne unique de 1 600 caractères
  portant cinq prescriptions. Dans la carte Codex, quatre nœuds partagent `[60,60]`. C'est la
  **citation** qui identifie, pas le numéro de ligne : inverser la hiérarchie, `quote` devient
  l'ancre normative.
- **Une ligne porte souvent plusieurs gestes** : la ligne 63 de wiki-brain en porte quatre,
  cartographiés en trois nœuds qui citent tous « l. 63 ».

### 5. `loop` sans collection : `until` + `budget`

La prescription **centrale** d'un agent de code n'a aucun type :

> « Please keep going until the query is completely resolved » — Codex CLI, l. 125

Pas de collection, donc pas un `loop` ; pas deux suites, donc pas une `decision`. Écrite en
`guard`, elle fait disparaître du graphe le fait principal, que l'agent tourne. **Zéro `loop`
sur les 213 nœuds du corpus public.**

Un `loop` licite sans `over`, avec `until` et un `budget` optionnel, récupère au passage les
trois budgets chiffrés aujourd'hui indistinguables de gardes ordinaires (« max 10 browser
actions », « 20+ étapes sans converger », « itérer jusqu'à 3 fois »).

Conséquence à prévoir : un `loop` de type « tant que » **produit un cycle dans `edges`**
(`wl4→wl1` chez `software-engineer`). Le schéma et le placement en couches doivent l'accepter.

### 6. `confidence` sur les arêtes

`confidence` existe sur les nœuds, pas sur les arêtes. Sur les deux cartes Fleet les plus
longues, exactement une arête était défendable dans les deux sens. Sans degré de certitude,
deux runs du cartographe ne sont pas comparables.

### 7. Un marqueur terminal

« Abandonne proprement avec `status: locked`, sans rien écrire » (wiki-brain) est un `step`
sans arête sortante : au rendu, indistinguable d'une carte inachevée. Un `kind: terminate` ou
un booléen `terminal`.

### 8. Déclarer l'agrégation — le format ment par omission sans elle

À grain constant (« un geste dont on peut dire s'il est fait ou pas »), les deux prompts
compta donnaient **100 et 76 nœuds**. Ils en font 70 et 67 : **environ 30 % d'agrégation**,
et **rien dans le fichier ne le signale**. Ces deux cartes passent pour exhaustives alors que
ce sont des sommaires fidèles.

La mesure est nette : la carte de référence tient **1 nœud pour 2 lignes** de prompt ; à 750
lignes on tombe à **1 nœud pour 10**. Le grain « geste » tient jusqu'à ~250 lignes ; au-delà
on cartographie des paragraphes. Signe clinique : les `detail` passent d'une phrase à trois
ou quatre, et plusieurs contiennent une énumération — c'est là que la matière est passée.

Ce qui a été perdu sur ces deux cartes, concrètement : les indices de détection par émetteur
et les préfixes de nommage (`ARC`, `RAMQ`, `VILLE-MONTREAL`) d'une table de classification,
et les six raisons normalisées d'un puits `ambiguous` réduit à un nœud.

Un `aggregated: true` (avec `aggregates: N`) sur le nœud suffit. Sans lui, toute consigne de
volume pousse mécaniquement le producteur à omettre en silence.

**Le repli va au rendu, pas au producteur** : le producteur émet un seul grain, le rendu
replie par `group`, qui est déjà obligatoire et porte déjà la numérotation des sections.

## Proposition examinée et **rejetée** : le type `criterion`

L'hypothèse était que `guard` sert de fourre-tout aux critères de qualification (les huit
conditions de qualification d'un bug chez Codex), et qu'un huitième type le dégonflerait.

**Le décompte nœud par nœud la réfute** : `criterion` prendrait **1 garde-fou sur 81**, mais
une dizaine de **politiques**. Il ferait donc *monter* la part de garde-fous. Sur `gtm` :
49,3 % → 49,3 %.

Le besoin est réel, la solution était fausse. `applies_to` (correction 1) le couvre.

## Ce que la part de `guard` mesure vraiment

Écart constaté : 18 % sur les cartes de référence, 42 % en moyenne sur le reste, jusqu'à 73 %.
Ce n'est **pas** une dérive de cartographie.

Le test qui départage `guard` de `policy` discrimine par la conséquence d'une violation. Sur
un document à déclencheurs il tranche bien. Sur une **constitution** — la plupart des agents
Fleet et publics en sont — les règles n'ont pas de déclencheur : « un cas qui ne s'est pas
présenté » ne s'applique jamais, et tout tombe sur `guard` par construction. Sur `gtm`, 19
des 35 garde-fous viennent de deux chapitres d'interdits consécutifs.

**À lire comme un indicateur du document au rendu, pas comme un défaut.**

Le mécanisme se lit à l'envers sur le corpus procédural, où le taux retombe à 17 % : **dans
une séquence, un critère de qualification a une place, donc il devient une `decision`** — « le
destinataire doit être Tractr », « au moins 50 caractères alphanumériques », « le compte
est-il dans la liste connue ». Dans une constitution il n'a pas de place et retombe sur
`guard`. C'est bien un effet de famille, pas un défaut du type.

## Un revers de la lecture de sens, à connaître avant de la vendre

Le §4.5 présente le rattachement par le sens comme un avantage sur la recherche textuelle, et
le corpus le confirme largement. Mais il produit aussi un effet inverse, observé une fois et
qui doit être documenté : sur `compta-trimestrielle`, `factures_stats` et `manifest_file_id`
sont rattachés par le sens, donc le croisement conclura « couvert » — alors que le bloc
« Format strict » du prompt **ne les liste ni l'un ni l'autre** et qu'une autre section range
les mêmes chiffres ailleurs. **Le rattachement par le sens a masqué une contradiction du
prompt** qu'un grep aurait fait ressortir. Rattrapé ici en `gap`, invisible à un croisement
automatique.

## Deux indicateurs calculables sans modèle

**La part de nœuds de flot** (hors `guard`/`policy`) sépare les familles :

```
sequence : 35 % à 82 %
policies :  0 % à 43 %
```

Et la zone de recouvrement est exactement la zone hybride : les quatre cartes situées entre
35 % et 43 % sont les quatre que les analyses ont signalées comme hybrides. Un `shape`
déclaré peut donc être vérifié par le serveur.

*(La densité d'arêtes, elle, ne mesure rien : rapportée aux seuls nœuds de flot elle vaut
~1,0 dans les deux familles. Toute procédure courte à ceinture épaisse de garde-fous était
lue comme cassée.)*

**L'indicateur d'équivalence-grep** : part des `refs` dont l'identifiant est nommé
littéralement dans la source. **Le gain du cartographe sur une recherche textuelle n'est pas
constant, il dépend du style du prompt** :

| Agent | outils nommés littéralement | rattachés par la carte |
|---|---|---|
| `on-call-copilot` | 1 sur 41 | 11 |
| `executive-assistant` | 6 sur 21 | 11 |
| `gtm` | 11 sur 16 | 11 |
| `mes-taches-clickup` | 5 sur 5 | 5 |

Quand l'indicateur vaut 100 %, le croisement n'apporte rien qu'un grep : il ne faut pas le
mettre en avant.

## Manques identifiés, non comblés

1. **Une précédence peut viser une action qui n'est pas un nœud.** « Normalize before you
   diagnose » (on-call), mais aucun passage ne prescrit de geste de diagnostic. Quatre cas.
   C'est l'intersection de deux bonnes règles — interdire d'inventer un nœud rend la
   précédence inexprimable. Signalé en `gaps`, faute de mieux.
2. **L'imbrication de composition.** Un livrable à quatre composants imbriqués (Preview /
   Thought process / Sources / note) n'est ni du contrôle (`parent`) ni une section (`group`).
3. **Un énoncé de fait n'a pas de type.** « Record URLs are automatically included in the
   `sources` array » borne une prescription sans rien prescrire. Le même agent l'a tranché de
   deux façons différentes sur deux cartes.
4. **Rien ne dit qu'une zone du prompt est mutable.** `software-engineer` a quatre blocs que
   son skill d'onboarding réécrit : le balayage nocturne y verra un écart légitime et
   régénérera pour rien. Touche la PR 8.
5. **Rien ne dit qu'un nœud est le même qu'un autre dans une autre carte.** Trois règles
   identiques écrites par deux auteurs dans deux agents de veille concurrentielle.
6. **Une table de décision devient un nœud.** Confirmé hors corpus maison, et aggravé : chez
   Codex et OpenHands, le résultat de la classification (P0-P3, LOW/MED/HIGH) est une *donnée
   de sortie*, pas un aiguillage.
7. **L'enseignement par l'exemple est hors de portée.** `codex:72-121` : 48 lignes de plans
   « high-quality » et « low-quality » sans un seul critère énoncé. La prescription est le
   contraste entre deux blocs. Réduit à un nœud, 48 lignes sur 275 perdues.
8. **`tool_call` ne distingue pas l'appel d'intégration de l'exécution locale.** Sur
   `compta-trimestrielle`, ses 21 `tool_call` sont 13 appels Drive authentifiés (credential
   injecté, déclarés au manifeste, faillibles réseau) et 8 scripts locaux (aucun credential,
   code versionné dans le skill, faillibles par `stderr`). Le prompt lui-même les traite
   différemment : « Script extracteur échoue : capturer la sortie stderr » contre « Upload
   Drive échoue : inclure le résultat local dans l'output ». Le rendu les affichera à
   l'identique.
9. **Une abrogation se lit comme une contrainte active.** « **Plus de STOP sur un CSV de
   paiements** » dit qu'une règle *n'existe plus*. Typée `guard`, elle prescrit exactement le
   contraire de ce qu'elle dit. Même famille : « Créer des dossiers est autorisé » est une
   permission bornée, pas une interdiction. Ni le test guard/policy ni aucun type ne les
   attrape : la violer n'est ni un défaut ni un cas non présenté, il n'y a rien à violer.
10. **Un corps de boucle peut être une alternative, pas une chaîne.** Dans la boucle de
    lecture de `compta-inbox`, la branche PDF et la branche CSV sont deux sous-graphes
    disjoints sous un même `parent`, qui dit « ces nœuds sont dans la boucle » sans jamais
    dire « ces deux moitiés ne coexistent pas ». Un rendu qui empile les enfants suggérera un
    enchaînement inexistant. Et rien ne dit que deux boucles parcourent le même ensemble : les
    8 passes successives de `compta-inbox` sur la même collection apparaîtront comme 8
    itérations indépendantes.
11. **Des arêtes traversent la frontière d'une boucle.** `s5.6 → s6.13` fait pointer l'enfant
    d'une boucle dans le corps d'une autre. Le contrôle de cohérence l'accepte et le format ne
    l'interdit pas : à trancher explicitement, interdire ou documenter, avant que le rendu ne
    dessine des flèches qui percent les boîtes.

## Portée du croisement, hors Appstrate

> Le croisement §4.5 est une fonctionnalité qui **suppose un manifeste** ; c'est un avantage
> d'Appstrate, pas une propriété du format.

Sur les quatre agents publics, un seul offre un croisement réel : le sous-agent Claude Code
et son frontmatter `tools:` — et là il est parfait, 3 sur 3 dans les deux sens, les six
placeholders `{{TEST_COMMAND}}` se rattachant naturellement en `config:<clé>`. Codex déclare
ses outils **en Rust**, OpenHands dans le **nom de fichier** de son snapshot.

Corollaire pour les imports : une référence non résolue ne doit pas toujours être une erreur.
Agent installé, manifeste connu → **erreur**. Agent importé d'ailleurs → **ligne de portage**.
Même machinerie, sévérité contextuelle.

## Constats hors du tableau §4.5

Trois formes de constat que le brief n'avait pas prévues, toutes vérifiées :

| Constat | Sévérité proposée | Cas |
|---|---|---|
| Planification déclarée qu'aucune règle ne couvre | avertissement | Le cron quotidien « Daily calendar and email brief » d'`executive-assistant` n'est décrit nulle part |
| Capacité accordée plus large que l'usage cartographié | avertissement | `wiki-brain` obtient le scope Drive complet alors que le prompt s'interdit toute écriture hors d'un dossier ; le scope Gmail, lui, est réduit à `readonly` |
| Inventaire de capacités non référencées, à distinguer d'un indice | inventaire | 45 outils non référencés chez `software-engineer` ne sont pas une anomalie : le prompt prescrit délibérément le jugement (« act with the appropriate tools ») |

## Bugs trouvés dans les agents, par la méthode

Trouvailles vérifiées une à une, qui existent indépendamment du chantier.

**Agents Tractr et core**

- `compta-gmail-harvest` : le prompt et la référence du skill nomment `@tractr/google-drive`,
  le manifeste déclare `@appstrate/google-drive`.
- `mes-taches-clickup` : la ligne 5 impose « le MINIMUM d'appels (idéalement 2 à 4) », la
  procédure en prescrit six au minimum, sept avec sa branche. **Trouvé par comptage des nœuds
  `tool_call`**, inatteignable autrement.
- `analyste-donnees` : l'étape 3 appelle `output` avec `visualisations`, l'étape 4 les
  produit. La procédure émet son résultat avant d'avoir calculé l'un de ses champs.
- `wiki-brain` : la règle « aucun secret » porte explicitement « **dans le wiki** », or
  l'ingestion dépose les **corps de mails intégraux** dans `raw/gmail/items/` sans filtrage.
  Un mot de passe reçu par courriel est écrit en clair pour `raw_retention_days`.
- `wiki-brain` : le chemin `locked` ordonne d'abandonner sans rien écrire, mais l'étape 7
  supprime `.lock` — destruction du verrou d'un run concurrent.
- `synthese-reunion` : l'entrée `contexte` est déclarée et jamais consommée.
- **`compta-inbox` et `compta-trimestrielle` se contredisent sur la même intégration.** Le
  premier écrit « n'utilise **PAS** le multipart (`uploadType=multipart`), qui échoue
  souvent » ; le second le prescrit **trois fois**. Même pipeline, même credential, consignes
  inverses. **Aucune carte mono-agent ne peut produire ce constat** : c'est l'argument direct
  pour un croisement inter-paquets.
- `compta-trimestrielle` : une branche est **non atteignable**. Le gap-fill CC est conditionné
  à un CSV « déposé dans l'Inbox ou indiqué par l'utilisateur », alors que l'agent n'a ni
  entrée de chemin ni configuration vers l'Inbox. Un tiers du dernier mois de chaque trimestre
  en dépend.
- `compta-inbox` : contradiction arithmétique en `dry_run`. Les compteurs `inserted`,
  `updated`, `total` sont exigés « toujours, dry_run inclus », alors que l'étape suivante
  saute la lecture du store : ils ne sont pas calculables, et la règle « ne jamais inventer de
  chiffres » interdit de les deviner.
- `compta-inbox` : `@default/compta-inbox-dispatch` dans le skill contre `@default/compta-inbox`
  au manifeste. Même famille que le `@tractr/google-drive` du premier cas.

**Agents tiers**

- OpenHands s'autorise et s'interdit la même action : sa section sécurité liste « Open pull
  requests » parmi ce qui est OK sans consentement, sa section PR l'interdit sans demande
  explicite.
- Codex se contredit entre ses deux prompts : le prompt de base interdit les plages de lignes
  dans les références, la rubrique de revue les rend obligatoires.
- `gtm` (Fleet) n'a pas de canal de sortie : sa seule sortie prescrite est « Render the result
  inline », alors que trois outils d'écriture Slack et `gmail_send_email` sont câblés. Son
  agent frère `executive-assistant` documente précisément ce piège.
- `on-call-copilot` : **la méthodologie qui fait autorité contredit le prompt.** Le fichier
  `memory/wiki/operations/intake-flow.md`, livré dans le même paquet, porte un algorithme en
  neuf étapes dont l'ordre est déclaré « MANDATORY » et « load-bearing » ; le prompt donne dix
  principes dans un ordre différent et n'introduit jamais l'étape `queue-union`. C'est le §4.3
  dans sa forme la plus dure : lire le seul prompt produit un ordre qui **contredit** la page
  qui fait foi.
- `x-content-manager` : trois outils de publication accordés, agent annoncé « Posts on X in
  your voice », et le prompt ne dit jamais de publier. Zéro nœud `emit`.

## Corrections à apporter au brief

- **§4.5 est inexact sur `wiki-brain`.** Le brief donne l'agent en exemple de faux positif au
  motif que « le prompt dit Drive 27 fois, jamais l'identifiant du package ». La ligne 191
  nomme bien `appstrate_google_drive__api_call`, en snake_case. Le grep échouait sur son motif
  de recherche, pas sur une absence. La conclusion tient, la démonstration est plus faible que
  ce qui est écrit.
- **Le §4.2 sous-estime l'hybride.** Il en cite un (`software-engineer`) ; le corpus en compte
  quatre, et l'enclave séquentielle la plus longue de `software-engineer` (`Codebase Work`,
  dix nœuds chaînés) n'est pas celle que le brief mentionne.
- **La règle « une famille sature les types que l'autre n'utilise pas » est fausse hors du
  corpus maison** : la rubrique de revue de Codex est `policies` avec **zéro** nœud `policy`
  (32 `guard`). Une rubrique est un document de *critères*, pas de déclencheurs.

## Fichiers

`*.logic-map.json` — 18 cartes · `corpus-web/` avec `PROVENANCE.md` (SHA de commit) ·
`check.mjs` (cohérence) et `verify-evidence.mjs` (citations) dans le scratchpad de session.
`integrity` est `null` partout : ces cartes ne sont attachées à aucune version publiée.
