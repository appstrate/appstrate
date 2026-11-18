# Upgrading beta.68 to beta.69

Use the [release runbook](https://github.com/appstrate/docs/blob/main/deployment/RELEASE_RUNBOOK.md) maintenance procedure with the application stopped. The two binaries cannot safely serve traffic against the same upgraded schema. The [migration reference](../../scripts/migration/README.md) gives the commands, prerequisites and expected output for each script.

## Prepare the release

1. Record the reviewed commit and verify its workflows, including PostgreSQL 16, Docker and browser tests. Run the Docker smoke check on a Docker host. Check the assembled OpenAPI with the deployed modules enabled against beta.68, including the chat routes. The [client migration notes](../../CHANGELOG.md#client-upgrade-from-beta68) cover paths, query filters and skill synchronization.
2. Publish `afps-shared@0.14.0`, confirm the tarball resolves from npm, then publish `core@17.0.0`. Update the external consumer `connect-helper` to the published major and refresh the export baseline using the published tarball. Verify the candidate CLI, GitHub Action and sync plugin against the candidate API. Follow the [core publication procedure](RELEASING_CORE.md).
3. Rehearse the steps below on a consistent restore of beta.68 with isolated credentials and external deliveries disabled. Record migration counts, elapsed time and the latest safe decision time for rollback. Run `0050-report-narrowing-overrides.ts` before the window and review every affected schedule with its owner. Verify model IDs with `bun run verify:system-models` under the deployment's module and model configuration.
4. Once the rehearsal passes, build the platform, Pi and sidecar from the same release revision. For Firecracker, verify the runner and guest artifacts for that release.

## Maintenance window

1. Drain runs and stop the application, workers and other writers. Record one UTC timestamp for `0053 --before`. Back up PostgreSQL, both package buckets (`agent-packages` and `library-packages`), and any logos needed by 0049 at the same point.
2. Run **0054 before Drizzle**. Dry-run with `--signing-dir DIR`; resolve every `UNFOLDED` line, including missing archives and publisher signatures. The reviewed dry-run must show zero unresolved entries before `--apply`. Preserve the signing directory across retries.
3. Run the release's migrate service for core journal entries 0097–0108. Apply 0048, then 0049 on instances that previously served 0097, 0051, and 0053 with the recorded timestamp. Run 0047 and 0052 in the window. Compare placement counts, manifests, stored integrity, dependency indexes and run-read rows with the rehearsal. Re-run the idempotent scripts.
4. Boot with `APPSTRATE_VERSION=1.0.0-beta.69` and `MIGRATIONS_ON_BOOT=verify`. Check readiness, runtime revisions, scheduler and installed modules. Run a signed local integration, verify its output and exercise the sidecar with the runbook's network canary. Check A, B and All spaces, run acknowledgements, chat history, and local skill sync. Reopen writes and schedules after acceptance; verify the installer and CLI npm channels separately.

## Roll back

After the first storage or database write, stop every writer and restore the database and **both buckets** to the same backup point. Restore beta.68 images and configuration. Check the migration journal, read a signed archive under the original trust policy and run an agent and a schedule before reopening traffic. If traffic has been reopened, preserve and reconcile subsequent writes before restoring. Record the backup identifiers, timings, test results and promoted channels in the deployment log.
