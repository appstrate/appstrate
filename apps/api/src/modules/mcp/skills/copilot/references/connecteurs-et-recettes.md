# Connecteurs Appstrate & recettes d'automatisation

> Chargé à la demande par le copilote en Phase 2 (proposer) et Phase 3 (résoudre l'accès).
> Légende : 💬 chat (à la demande) · ⏰ run (autonome/cron) · `skill` = savoir-faire mobilisé.

## Connecteurs built-in (~64), par famille

| Famille             | Connecteurs `@appstrate/*`                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| E-mail              | `gmail`, `gmail-mcp`, `microsoft-outlook`, `brevo`, `mailchimp`, `convertkit`                              |
| Agenda & réunions   | `google-calendar`, `calendly`, `zoom`, `fathom` (transcripts), `loom`                                      |
| Messagerie interne  | `slack`, `microsoft-teams`, `discord`, `telegram`                                                          |
| Docs & knowledge    | `google-drive`, `onedrive`, `dropbox`, `notion`, `notion-mcp`, `google-sheets`, `airtable`                 |
| Tâches & projet     | `clickup`, `clickup-mcp`, `jira`, `linear`, `asana`, `monday`, `basecamp`, `teamwork`, `wrike`, `shortcut` |
| CRM                 | `hubspot`, `salesforce`, `pipedrive`, `zoho-crm`, `dynamics365`, `freshsales`, `activecampaign`            |
| Support / ticketing | `zendesk`, `intercom`, `freshdesk`                                                                         |
| Web & veille        | `firecrawl` (crawl/scrape/search), `reddit`, `youtube`, `x`, `linkedin`                                    |
| Dev                 | `github`, `github-git`, `github-mcp`                                                                       |
| Finance             | `stripe`, `paypal`, `quickbooks-online`, `xero`                                                            |
| E-commerce / CMS    | `shopify`, `woocommerce`, `wordpress`, `canva`, `pinterest`                                                |
| Forms / infra       | `typeform`, `google-forms`, `twilio` (SMS), `webhooks`                                                     |

> Préfère la saveur **MCP** quand elle existe (`gmail-mcp`, `clickup-mcp`, `notion-mcp`, `github-mcp`) : tools nommés plus riches, self-describing via `tools/list`.
> **Pas dans la liste ?** Ce n'est pas bloquant — voir la cascade (MCP distant / scaffolder) dans `SKILL.md` Phase 3 et `format-agent-appstrate.md`.

## Recettes par connecteur

### 📧 Mail — `gmail` / `microsoft-outlook`

- ⏰ Brief inbox du matin (tri + résumé + priorités) · `triage-sentiment`
- ⏰ Auto-brouillons de réponses récurrentes · `email-reply`
- ⏰ Extraire les engagements/tâches des mails → projet · `minutes-actions`
- ⏰ Alerte VIP / mots-clés (devis, résiliation, plainte) · `triage-sentiment`
- 💬 Réponds à ce fil dans mon ton · `email-reply`

### 📁 Drive — `google-drive` / `onedrive` / `dropbox` / `notion`

- 💬 Q&A sourcé sur tes documents · `sourced-rag`
- ⏰ Résumé des nouveaux fichiers (hebdo) · `incremental-digest`
- 💬 Extraire les infos clés d'un doc (contrat, facture, CV) · `doc-extraction`
- ⏰ Veille sur un dossier partagé → notifier · `incremental-digest`

### 📋 Gestion de projet — `clickup` / `jira` / `linear` / `asana` / `notion`

- ⏰ Digest des tâches dues / en retard (matin) · `incremental-digest`
- 💬 Crée une tâche depuis ce message/mail · (orchestration)
- ⏰ Rapport d'avancement hebdo (sprint/projet) · `sprint-report`
- ⏰ Relancer les tâches sans update depuis N jours · (orchestration)

### 🧾 Facturation — `quickbooks-online` / `xero` / `stripe`

- ⏰ Relances d'impayés automatiques · (orchestration)
- ⏰ Rapport cash / encaissements hebdo · `data-analysis`
- ⏰ Catégoriser les transactions · `data-analysis`
- 💬 Statut de la facture X ? · (orchestration)

### 📅 Calendrier & réunions — `google-calendar` / `zoom` / `fathom`

- ⏰ Prépa des réunions du jour (participants + docs liés) · `meeting-prep`
- ⏰ CR + actions après chaque réunion (Fathom) · `minutes-actions`
- 💬 Trouve un créneau avec X · (orchestration)

### 💬 Messagerie interne — `slack` / `microsoft-teams`

- ⏰ Digest des canaux clés + décisions + actions · `incremental-digest`
- 💬 Résume #canal depuis hier · `minutes-actions`
- ⏰ FAQ interne dans un canal · `sourced-rag`

### 🤝 CRM — `hubspot` / `salesforce` / `pipedrive`

- 💬 Brief avant call · `customer-research`
- ⏰ Relances pipeline du jour · (orchestration)
- ⏰ Qualifier les leads entrants vs ICP · `customer-research`

### 🎧 Support — `zendesk` / `intercom` / `freshdesk`

- ⏰ Tri + priorisation + sentiment des tickets · `triage-sentiment`
- ⏰ Brouillons depuis la KB · `sourced-rag`
- ⏰ Voice of customer → produit · `triage-sentiment`

### 👩‍💻 Dev — `github-mcp` / `jira` / `linear`

- ⏰ Résumé des PR ouvertes (matin) · `code-review`
- 💬 Explique cette PR / ce diff · `code-review`
- ⏰ Triage des issues entrantes · `triage-sentiment`

### 🌐 Veille (transverse) — `firecrawl` + livraison `slack`/`gmail`

- ⏰ Veille concurrents / sujets → digest du nouveau (checkpoint) · `incremental-digest`
- 💬 Cherche & synthétise un sujet maintenant · `sourced-research`
