/**
 * Satellite-container lifecycle around a `db reset`'s database recreate, on both the
 * PG14 (DROP/CREATE in place) and PG15+ (container recreate) paths: the satellites
 * (storage/auth/realtime/pooler) are stopped while the database is being rebuilt
 * ({@link legacyWithSatelliteFence}) and restarted once it is back
 * ({@link legacyRestartServicesAndReloadKong}), followed by a Kong nginx reload so
 * its cached upstream addresses (which may have changed if a satellite came back on
 * a different one) stop 502ing. Neither `db start` nor `supabase start` calls any of
 * this: it exists purely to keep the satellites away from a `db` container being
 * recreated or force-restarted out from under them.
 */

import { Cause, Data, Effect, Option, Result } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

import { Output } from "../../../shared/output/output.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";
import { legacyAqua, legacyYellow } from "../legacy-colors.ts";
import {
  legacyCollectText,
  legacyDescribeContainerCliFailure,
  legacyIsContainerNotFoundMessage,
  legacyRunContainerCliExpectSuccess,
  spawnContainerCli,
} from "../legacy-container-cli.ts";
import { legacyInspectContainerState } from "../legacy-docker-lifecycle.ts";
import { legacyServiceContainerName } from "../legacy-docker-ids.ts";

type Spawner = ChildProcessSpawner["Service"];

/** `docker restart <id>` (the db container itself) failed — used only by PG14's `RestartDatabase`. */
export class LegacyContainerRestartError extends Data.TaggedError("LegacyContainerRestartError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.startStack;
  }
}

/**
 * Port of Go's `Docker.ContainerRestart(ctx, utils.DbId, container.StopOptions{})`
 * (`apps/cli-go/internal/db/reset/reset.go:218-220`), used ONLY by PG14's
 * `RestartDatabase` to restart the `db` container itself after `pg_terminate_backend`
 * (pg_cron must restart, per Go's own comment). Unlike the satellite restarts below,
 * this one does NOT tolerate "not found" — Go's own `RestartDatabase` has no
 * `errdefs.IsNotFound` guard on this call at all, so ANY failure is a hard
 * `failed to restart container: %w`.
 */
export function legacyRestartContainer(
  spawner: Spawner,
  containerId: string,
): Effect.Effect<void, LegacyContainerRestartError> {
  return legacyRunContainerCliExpectSuccess(
    spawner,
    ["restart", containerId],
    "restart container",
    (message) => new LegacyContainerRestartError({ message }),
  );
}

type SatelliteOp = "restart" | "start" | "stop";

/**
 * One satellite container's `docker restart`/`start`/`stop`, tolerant of "not found":
 * a service excluded from the stack (e.g. `[realtime] enabled = false`) has no
 * container to act on, and that's not an error. (`stop` on a stopped container and
 * `start` on a running one exit 0, so neither needs extra tolerance.) Never fails the
 * surrounding `Effect.all` itself: resolves `Option.some(message)` on a genuine
 * failure so {@link legacySatelliteSetOp} can join every container's outcome, and
 * `Option.none()` on success or a tolerated not-found.
 */
const legacySatelliteOp = (
  spawner: Spawner,
  op: SatelliteOp,
  containerId: string,
): Effect.Effect<Option.Option<string>> =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawnContainerCli(spawner, [op, containerId], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
      const [exitCode, stderr] = yield* Effect.all(
        [child.exitCode.pipe(Effect.map(Number)), legacyCollectText(child.stderr)],
        { concurrency: "unbounded" },
      );
      if (exitCode === 0) return Option.none();
      const trimmed = stderr.trim();
      if (legacyIsContainerNotFoundMessage(trimmed)) return Option.none();
      return Option.some(
        `failed to ${op} ${containerId}: ${trimmed.length > 0 ? trimmed : `exit ${exitCode}`}`,
      );
    }),
  ).pipe(
    Effect.catch((cause) =>
      Effect.succeed(
        Option.some(`failed to ${op} ${containerId}: ${legacyDescribeContainerCliFailure(cause)}`),
      ),
    ),
  );

/**
 * The containers every op targets: the `unless-stopped` services whose boot-time
 * migrations write to the `postgres` database. NOT PostgREST (it reconnects and
 * re-reads the schema on its own), NOT Kong (reloaded in place, never restarted), NOT
 * analytics (its migration lives in the separate `_supabase` database, which the
 * one-shot migrate jobs never touch, so it just crash-loops until the reset is done —
 * exactly as it does during `supabase start`).
 */
function legacySatelliteContainerIds(projectId: string): ReadonlyArray<string> {
  return [
    legacyServiceContainerName("storage", projectId),
    legacyServiceContainerName("auth", projectId),
    legacyServiceContainerName("realtime", projectId),
    legacyServiceContainerName("pooler", projectId),
  ];
}

/**
 * Runs one `docker <op>` over the whole satellite set CONCURRENTLY, without waiting
 * for anything to become healthy afterward (a service may be excluded from the
 * stack), and joins every genuine failure into one newline-separated message.
 */
function legacySatelliteSetOp<E>(
  spawner: Spawner,
  projectId: string,
  op: SatelliteOp,
  onFailure: (message: string) => E,
): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const results = yield* Effect.all(
      legacySatelliteContainerIds(projectId).map((containerId) =>
        legacySatelliteOp(spawner, op, containerId),
      ),
      { concurrency: "unbounded" },
    );
    const failures = results.filter(Option.isSome).map((result) => result.value);
    if (failures.length > 0) {
      return yield* Effect.fail(onFailure(failures.join("\n")));
    }
  });
}

/**
 * One or more satellite-service restarts (or restore-path starts) failed; the
 * per-container messages are newline-joined.
 */
export class LegacyRestartServicesError extends Data.TaggedError("LegacyRestartServicesError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.startStack;
  }
}

/**
 * One or more satellite-service stops failed before the database was touched; the
 * per-container messages are newline-joined.
 */
export class LegacyStopServicesError extends Data.TaggedError("LegacyStopServicesError")<{
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.startStack;
  }
}

/**
 * The pre-teardown fence (https://github.com/supabase/cli/issues/6445). An explicit
 * `docker stop` marks each satellite manually-stopped, which disarms its
 * `unless-stopped` restart policy; without it, a satellite that crashes when its
 * database vanishes is auto-restarted by the daemon straight into the "Initialising
 * schema..." window, where its boot-time migrations race the one-shot migrate jobs on
 * the fresh database and either side can exit non-zero.
 */
function legacyStopSatelliteServices(
  spawner: Spawner,
  projectId: string,
): Effect.Effect<void, LegacyStopServicesError> {
  return legacySatelliteSetOp(
    spawner,
    projectId,
    "stop",
    (message) =>
      new LegacyStopServicesError({
        message,
        suggestion: `The database was not touched. Retry the reset, or run ${legacyAqua(
          "supabase stop",
        )} then ${legacyAqua("supabase start")} if the container stays stuck.`,
      }),
  );
}

/**
 * Gateway-recovery hint, byte-matching Go's `suggestKongRecovery`
 * (`reset.go:281-288`): rendered as a `Suggestion:` line by `Output.fail`, mirroring
 * `utils.CmdSuggestion`.
 */
function legacyKongRecoverySuggestion(kongId: string): string {
  return (
    "Local services restarted, but API routes may return 502 until the gateway reloads.\n" +
    `Try restarting it with ${legacyAqua(`docker restart ${kongId}`)}, and check ${legacyAqua(
      `docker logs ${kongId}`,
    )} if the failure persists.`
  );
}

/** Kong could not be reloaded — fails the WHOLE command (unlike `functions serve`'s best-effort reload). */
export class LegacyKongReloadError extends Data.TaggedError("LegacyKongReloadError")<{
  readonly message: string;
  readonly suggestion: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.startStack;
  }
}

/** `docker exec <id> <cmd...>`, combined stdout+stderr into one buffer — mirrors Go's shared `io.Writer` in `DockerExecOnceWithStream(ctx, KongId, "", nil, cmd, &out, &out)`. Never fails the Effect itself: a spawn failure (no docker/podman) folds into `exitCode: 1`. */
function legacyExecCaptureCombined(
  spawner: Spawner,
  containerId: string,
  cmd: ReadonlyArray<string>,
): Effect.Effect<{ readonly exitCode: number; readonly output: string }> {
  return Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawnContainerCli(spawner, ["exec", containerId, ...cmd], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = yield* Effect.all(
        [
          child.exitCode.pipe(Effect.map(Number)),
          legacyCollectText(child.stdout),
          legacyCollectText(child.stderr),
        ],
        { concurrency: "unbounded" },
      );
      return { exitCode, output: stdout + stderr };
    }),
  ).pipe(
    Effect.catch((cause) =>
      Effect.succeed({ exitCode: 1, output: legacyDescribeContainerCliFailure(cause) }),
    ),
  );
}

/**
 * Port of Go's `reloadKong` (`reset.go:253-276`): inspect Kong's container — not
 * found means Kong is excluded from the stack (`return nil`, not an error); any OTHER
 * inspect failure is wrapped with the recovery suggestion; not running means there's
 * no stale cache to flush (`return nil`); otherwise `docker exec <kongId> kong reload
 * --nginx-conf /home/kong/custom_nginx.template` (the flag is required — a bare
 * `kong reload` regenerates nginx.conf from Kong's default template and drops the
 * custom `email_templates` server, reintroducing #6059), failing hard (with the same
 * suggestion) on a non-zero exit, the combined output appended when non-empty. Not
 * exported outside this module — only {@link legacySatelliteSetOpAndReloadKong}
 * calls this directly.
 */
function legacyReloadKong(
  spawner: Spawner,
  projectId: string,
): Effect.Effect<void, LegacyKongReloadError> {
  const kongId = legacyServiceContainerName("kong", projectId);
  return Effect.gen(function* () {
    const inspected = yield* legacyInspectContainerState(spawner, kongId).pipe(Effect.result);
    if (Result.isFailure(inspected)) {
      if (legacyIsContainerNotFoundMessage(inspected.failure.message)) return;
      return yield* Effect.fail(
        new LegacyKongReloadError({
          message: `failed to inspect kong: ${inspected.failure.message}`,
          suggestion: legacyKongRecoverySuggestion(kongId),
        }),
      );
    }
    if (!inspected.success.running) return;
    const result = yield* legacyExecCaptureCombined(spawner, kongId, [
      "kong",
      "reload",
      "--nginx-conf",
      "/home/kong/custom_nginx.template",
    ]);
    if (result.exitCode !== 0) {
      const trimmed = result.output.trim();
      // Go's `DockerExecOnceWithStream` (`utils/docker.go:646-648`) sets a FIXED constant
      // error, `errors.New("error executing command")`, for `iresp.ExitCode > 0` — not the
      // exit code itself. `reloadKong` then wraps it as `failed to reload kong: %w[:\n%s]`
      // (`reset.go:269-274`), so the `%w` slot is always this exact string, never `exit N`.
      return yield* Effect.fail(
        new LegacyKongReloadError({
          message:
            trimmed.length > 0
              ? `failed to reload kong: error executing command:\n${trimmed}`
              : "failed to reload kong: error executing command",
          suggestion: legacyKongRecoverySuggestion(kongId),
        }),
      );
    }
  });
}

/**
 * `docker <op>` over the satellite set, then {@link legacyReloadKong} — ONLY when
 * every satellite succeeded (the joined satellite error is returned without ever
 * attempting the Kong reload).
 */
function legacySatelliteSetOpAndReloadKong(
  spawner: Spawner,
  projectId: string,
  op: "restart" | "start",
): Effect.Effect<void, LegacyRestartServicesError | LegacyKongReloadError> {
  return Effect.gen(function* () {
    yield* legacySatelliteSetOp(
      spawner,
      projectId,
      op,
      (message) => new LegacyRestartServicesError({ message }),
    );
    yield* legacyReloadKong(spawner, projectId);
  });
}

/** The post-recreate step (Go's `restartServices`, `reset.go:227-241`): restart the satellites, then reload Kong. */
export function legacyRestartServicesAndReloadKong(
  spawner: Spawner,
  projectId: string,
): Effect.Effect<void, LegacyRestartServicesError | LegacyKongReloadError> {
  return legacySatelliteSetOpAndReloadKong(spawner, projectId, "restart");
}

/**
 * The failed-reset restore: `docker start` the fenced satellites (a no-op on one that
 * is already running, so a partial stop is undone too), then reload Kong.
 */
function legacyRestoreSatelliteServices(
  spawner: Spawner,
  projectId: string,
): Effect.Effect<void, LegacyRestartServicesError | LegacyKongReloadError> {
  return legacySatelliteSetOpAndReloadKong(spawner, projectId, "start");
}

/**
 * Runs `body` — the reset's database teardown and rebuild — with the satellites
 * stopped ({@link legacyStopSatelliteServices}), and brings them back
 * ({@link legacyRestoreSatelliteServices}) when it fails, so a failed reset (a bad
 * migration or seed is the everyday case) does not leave them down. The caller
 * restarts them itself on success, so the fence ends where that restart begins and
 * never re-runs it — or the Kong reload — after a failure of its own.
 *
 * The restore also runs for a defect (a broken stderr pipe mid-reset, say), but not
 * for a plain interruption: Ctrl-C must not be held up by four `docker start`s. When
 * the restore itself fails, the user has to know the services are down, so say so on
 * stderr alongside the reset's own error — the one worth reporting — instead of
 * replacing it.
 */
export function legacyWithSatelliteFence<A, E, R>(
  spawner: Spawner,
  projectId: string,
  body: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | LegacyStopServicesError, R | Output> {
  const warn = (text: string) =>
    Effect.gen(function* () {
      const output = yield* Output;
      yield* output.raw(`${legacyYellow("WARNING:")} ${text}\n`, "stderr");
    });
  return Effect.gen(function* () {
    yield* legacyStopSatelliteServices(spawner, projectId);
    return yield* body;
  }).pipe(
    Effect.tapCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      () =>
        legacyRestoreSatelliteServices(spawner, projectId).pipe(
          Effect.catchTags({
            LegacyRestartServicesError: (error) =>
              warn(
                `the local services could not be restarted after the failed reset: ${error.message}\nRun ${legacyAqua("supabase stop")} then ${legacyAqua("supabase start")} to bring them back.`,
              ),
            LegacyKongReloadError: (error) => warn(`${error.message}\n${error.suggestion}`),
          }),
        ),
    ),
  );
}
