# Explicit saves throughout the UI

Every editable user setting stays local until an explicit Save (or named submission); display preferences (theme, cards/table choice, column widths and visibility, chat model/generation/authoring) apply at once. Changing a value, blurring, waiting, hiding the page and unmounting must not persist it. Cancel restores stored values. Failed saves retain edits and block save-and-leave navigation. Refetches preserve dirty edits; a change of organization or space drops them after the guard has asked. Multiple independent forms must remain guarded together.

| Surface                                                                           | Save boundary                                                                                              |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Agent model and generation                                                        | One request for the pair                                                                                   |
| Agent proxy                                                                       | One independent form                                                                                       |
| Default inputs and locks                                                          | One full replacement                                                                                       |
| Schedule                                                                          | Existing common draft across its sections                                                                  |
| Package definition and files                                                      | Existing draft editors; publication remains separate                                                       |
| Organization identity/logo and policy switches                                    | Independent resources with their own saves                                                                 |
| Space general settings                                                            | One patch containing changed fields only; preserve personal-space restrictions and visibility confirmation |
| Profile and language                                                              | Explicit saves, including localStorage preferences                                                         |
| Connection choices                                                                | Local member pin until Save; per-run/schedule overrides remain local to their parent form                  |
| Connection sharing                                                                | One independent permission change per target space                                                         |
| Integration defaults and enforcement mode                                         | One set and mode saved together                                                                            |
| Member roles                                                                      | Explicit role confirmation or staged role assignment                                                       |
| Inline names                                                                      | Save/Cancel or explicit Enter; blur never saves                                                            |
| OAuth/SMTP, webhook, credentials, models/proxies, billing, invitations, end-users | Preserve existing explicit form submissions and named actions                                              |

Named commands (Send, Run, Delete, Connect, Set as default, share/withdraw actions) already express a commit. Runtime data (messages after Send, runs, logs, auth), navigation state (selected organization/space, sidebar) and pairing recovery continue to persist as part of their operation. They are not unsaved editable forms.

The shared save bar and navigation guard provide consistent behavior; existing API contracts, permissions and validation remain authoritative. No global save spans independent endpoints. No database migration is needed.

Validation covers idle/blur without writes, cancel, failure/retry, dirty refetch, multiple dirty forms, successful save before navigation, reload, member pin selection and existing package/schedule saves.
