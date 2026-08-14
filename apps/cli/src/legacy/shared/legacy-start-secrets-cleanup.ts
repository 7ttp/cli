import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { Effect } from "effect";

import type { LegacyContainerIdName } from "./legacy-docker-lifecycle.ts";

/**
 * Best-effort removal of Edge Runtime's per-container staging directory under
 * `<workdir>/supabase/.temp/start-secrets/`. Its direct `docker run -d` flow
 * persistently bind-mounts the env file, multiline-env script, and serve-main
 * template written there, so `stop` and failed-start rollback must reclaim the
 * plaintext after the container is gone. There is no Go behavior to match;
 * this is a TS-port-only hygiene step.
 *
 * Kong/Postgres/Supavisor do not use this tree. `legacyCreateContainer` packs
 * all of one container's `secretFiles` into a mode-`0644` in-memory Bun tar
 * archive and streams it through `docker cp - <id>:/`, so those secrets never
 * touch host disk and need no teardown cleanup. The pathless transfer works
 * with remote daemons and confined Docker clients.
 *
 * Hoisted here (`legacy/shared/`) per `apps/cli/CLAUDE.md`'s "Hoist Before
 * You Duplicate" rule: both `start`'s own rollback
 * (`legacy/shared/db-bootstrap/rollback.ts`) and `stop` (`stop.handler.ts`) need
 * this same cleanup.
 *
 * Each container's own directory is resolved as `<workdir>/supabase/.temp/
 * start-secrets/<name>`, where `workdir` is that container's own
 * `LEGACY_CLI_WORKDIR_LABEL` value (see that constant's doc comment) — NOT
 * necessarily `fallbackWorkdir` (the caller's own `LegacyCliConfig.workdir`).
 * A caller tearing down containers by an explicit `--project-id`/`--all`
 * filter may be tearing down a DIFFERENT project's containers than the one
 * its own cwd/`--workdir` points at, so using the caller's workdir
 * unconditionally would look in the wrong directory and silently orphan that
 * project's Edge Runtime staging. `fallbackWorkdir` is used only for a
 * container whose own label is empty — created before this label existed
 * (or by a Go binary, which never sets it).
 *
 * `containers` MUST be exactly the containers Docker itself reported as
 * matching the same label filter the caller just tore down, and only once
 * that teardown is CONFIRMED complete (`legacyDockerRemoveAll`'s
 * `onContainersRemoved` hook) — never independently reconstructed/guessed,
 * and never a pre-teardown snapshot, since a container that a later stage
 * failed to actually remove must keep its bind-mounted files. This also avoids a
 * blanket delete of the whole `start-secrets/` parent directory, which would
 * be unsafe if a workdir's project id ever changed across `start` runs
 * without an intervening `stop`: that parent could then hold subdirectories
 * for more than one project id, some possibly still backing a live Edge
 * Runtime container that a narrower `stop --project-id`/rollback is not
 * tearing down.
 *
 * Never fails: a directory that was never staged (every service besides Edge
 * Runtime) is a harmless no-op, and a real deletion error is not worth
 * failing `stop`/rollback over.
 *
 * `container.name` is a `docker ps` field value read back off whatever containers matched
 * the caller's label filter (`legacyListContainerIdsAndNames`) — external metadata, not
 * something this function generated itself, so it cannot be trusted as a bare path segment
 * without a defence-in-depth check. Resolve the candidate and require it to be a direct
 * child of the staging root before deleting it — same defence-in-depth shape as
 * `bootstrap.templates.ts`'s identical guard against a GitHub-supplied path escaping its
 * target directory. This also covers the degenerate case where `container.name` ends up
 * empty (would otherwise resolve to the staging root itself and wipe every project's
 * Edge Runtime staging).
 */
export function legacyCleanupStartSecrets(
  containers: ReadonlyArray<LegacyContainerIdName>,
  fallbackWorkdir: string,
): Effect.Effect<void> {
  return Effect.tryPromise(() =>
    Promise.all(
      containers.map((container) => {
        const workdir = container.workdir.length > 0 ? container.workdir : fallbackWorkdir;
        const stagingRoot = resolve(workdir, "supabase", ".temp", "start-secrets");
        const target = resolve(stagingRoot, container.name);
        if (target === stagingRoot || !target.startsWith(stagingRoot + sep)) {
          return Promise.resolve();
        }
        return rm(target, {
          recursive: true,
          force: true,
        });
      }),
    ),
  ).pipe(
    Effect.asVoid,
    Effect.orElseSucceed(() => undefined),
  );
}
