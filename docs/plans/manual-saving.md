# Explicit saves throughout the UI

Every editable user setting stays local until an explicit Save (or named submission); display preferences (theme, cards/table choice, column widths and visibility, chat model/generation/authoring) apply at once. Changing a value, blurring, waiting, hiding the page and unmounting must not persist it. Cancel restores stored values. Failed saves retain edits and block save-and-leave navigation. Refetches preserve dirty edits; a change of organization or space drops them after the guard has asked. Multiple independent forms must remain guarded together.

| Surface                                                                           | Save boundary                                                                                              |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Agent model and generation                                                        | One request for the pair                                                                                   |
| Agent proxy                                                                       | One independent form                                                                                       |
| Default inputs and locks                                                          | One full replacement                                                                                       |
| Schedule                                                                          | Existing common draft across its sections                                                                  |
| Package definition and files                                                      | Existing draft editors; publication remains separate                                                       |
| Organization identity and logo                                                    | Independent resources with their own saves                                                                 |
| Space general settings                                                            | One patch containing changed fields only; preserve personal-space restrictions and visibility confirmation |
| Profile name and language                                                         | Explicit saves                                                                                             |
| Integration defaults and enforcement mode                                         | One set and mode saved together                                                                            |
| Organization member roles                                                         | Explicit role confirmation                                                                                 |
| Inline names                                                                      | Save/Cancel or explicit Enter; blur never saves                                                            |
| OAuth/SMTP, webhook, credentials, models/proxies, billing, invitations, end-users | Preserve existing explicit form submissions and named actions                                              |

Named commands (Send, Run, Delete, Connect, Set as default, share/withdraw actions) already express a commit, and so does a single switch or select whose change is the command: package activation in a space, a space member's role, connection sharing and picks, organization policy switches. Imposing a skill on a space's chat asks for confirmation first. Runtime data (messages after Send, runs, logs, auth), navigation state (selected organization/space, sidebar) and pairing recovery continue to persist as part of their operation. They are not unsaved editable forms.

The shared save bar and navigation guard provide consistent behavior; existing API contracts, permissions and validation remain authoritative. No global save spans independent endpoints. No database migration is needed.

Validation covers idle/blur without writes, cancel, failure/retry, dirty refetch, multiple dirty forms, successful save before navigation, reload and existing package/schedule saves.
