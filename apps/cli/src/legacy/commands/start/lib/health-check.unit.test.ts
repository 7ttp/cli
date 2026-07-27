import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";

import {
  LegacyHealthCheckTimeoutError,
  legacyWaitForHealthyServices,
  type LegacyHealthCheckPostgrestGateway,
} from "./health-check.ts";

/**
 * A spawner that answers `docker container inspect`/`docker logs` calls.
 * `inspectResponse` is called once per `(containerId, callIndex)` pair — the
 * `callIndex` (0-based, per container) lets a test script a container's
 * health across successive polling rounds. `docker logs` calls (the
 * timeout-path debug dump) always succeed with empty output.
 */
function mockHealthSpawner(
  inspectResponse: (containerId: string, callIndex: number) => string,
  opts: {
    readonly logs?: Readonly<Record<string, string | ReadonlyArray<string>>>;
    readonly images?: Readonly<Record<string, string>>;
  } = {},
) {
  const counts = new Map<string, number>();
  const encoder = new TextEncoder();
  const spawned: Array<ReadonlyArray<string>> = [];

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const args = command._tag === "StandardCommand" ? command.args : [];
      spawned.push(args);

      let stdout: ReadonlyArray<string> = [];
      if (args[0] === "container" && args[1] === "inspect" && args[4] === "{{.Config.Image}}") {
        const image = opts.images?.[args[2] ?? ""];
        stdout = image === undefined ? [] : [image];
      } else if (args[0] === "container" && args[1] === "inspect") {
        const containerId = args[2] ?? "";
        const callIndex = counts.get(containerId) ?? 0;
        counts.set(containerId, callIndex + 1);
        stdout = [inspectResponse(containerId, callIndex)];
      } else if (args[0] === "logs") {
        const logs = opts.logs?.[args[1] ?? ""];
        stdout = logs === undefined ? [] : typeof logs === "string" ? [logs] : logs;
      }

      const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(0));
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        stdout: Stream.fromIterable(stdout.map((chunk) => encoder.encode(chunk))),
        stderr: Stream.empty,
        all: Stream.empty,
        exitCode: Deferred.await(exitDeferred),
        isRunning: Effect.succeed(false),
        stdin: Sink.drain,
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );

  return {
    spawner,
    get spawned() {
      return spawned;
    },
  };
}

const runningHealthy = JSON.stringify({
  Status: "running",
  Running: true,
  Health: { Status: "healthy" },
});
const runningStarting = JSON.stringify({
  Status: "running",
  Running: true,
  Health: { Status: "starting" },
});
const notRunning = JSON.stringify({ Status: "exited", Running: false });

/**
 * `legacyWaitForHealthyServices` structurally requires `HttpClient.HttpClient`
 * (only exercised on the PostgREST HTTP-HEAD branch) — every test provides
 * some `HttpClient.HttpClient`, and this one fails loudly if a
 * container-only-health-check test ever calls it unexpectedly.
 */
const unusedHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die("HttpClient should not be called for a plain container check")),
);

describe("legacyWaitForHealthyServices", () => {
  it.effect(
    "polls on a 1-second backoff until the container reports healthy, without waiting a full timeout",
    () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner((_id, callIndex) =>
          callIndex === 0 ? runningStarting : runningHealthy,
        );

        const fiber = yield* legacyWaitForHealthyServices(mock.spawner, ["supabase_kong_proj"], {
          timeoutSeconds: 30,
        }).pipe(
          Effect.provide(unusedHttpClientLayer),
          Effect.forkChild({ startImmediately: true }),
        );

        yield* TestClock.adjust("1 seconds");
        const exit = yield* Fiber.await(fiber);

        expect(Exit.isSuccess(exit)).toBe(true);
        const inspectCalls = mock.spawned.filter(
          (args) => args[0] === "container" && args[1] === "inspect",
        );
        expect(inspectCalls).toHaveLength(2);
      }),
  );

  it.effect(
    "stops probing a container once it becomes healthy, and only reports the still-unhealthy one on timeout",
    () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner((containerId) =>
          containerId === "supabase_kong_proj" ? runningHealthy : notRunning,
        );

        const fiber = yield* legacyWaitForHealthyServices(
          mock.spawner,
          ["supabase_kong_proj", "supabase_rest_proj"],
          { timeoutSeconds: 2 },
        ).pipe(Effect.provide(unusedHttpClientLayer), Effect.forkChild({ startImmediately: true }));

        // 2 retries after the initial attempt (Go's `WithMaxRetries(..., timeout.Seconds())`).
        yield* TestClock.adjust("1 seconds");
        yield* TestClock.adjust("1 seconds");
        const exit = yield* Fiber.await(fiber);

        expect(Exit.isFailure(exit)).toBe(true);

        const kongCalls = mock.spawned.filter(
          (args) =>
            args[0] === "container" && args[1] === "inspect" && args[2] === "supabase_kong_proj",
        );
        const restCalls = mock.spawned.filter(
          (args) =>
            args[0] === "container" && args[1] === "inspect" && args[2] === "supabase_rest_proj",
        );
        // The healthy container is probed exactly once, then narrowed out of
        // the "still watching" set — the unhealthy one is probed on every round.
        expect(kongCalls).toHaveLength(1);
        expect(restCalls).toHaveLength(3);
      }),
  );

  it.effect(
    "fails with LegacyHealthCheckTimeoutError carrying only the still-unhealthy container's reason",
    () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner(() => notRunning);

        const fiber = yield* legacyWaitForHealthyServices(mock.spawner, ["supabase_rest_proj"], {
          timeoutSeconds: 1,
        }).pipe(
          Effect.provide(unusedHttpClientLayer),
          Effect.forkChild({ startImmediately: true }),
        );

        yield* TestClock.adjust("1 seconds");
        const error = yield* Fiber.join(fiber).pipe(Effect.flip);

        expect(error).toBeInstanceOf(LegacyHealthCheckTimeoutError);
        expect(error.unhealthy).toEqual([
          { containerId: "supabase_rest_proj", reason: "container is not running: exited" },
        ]);
        expect(error.message).toBe("supabase_rest_proj: container is not running: exited");
      }),
  );

  it.effect("dumps container logs to stderr on a genuine timeout", () =>
    Effect.gen(function* () {
      const mock = mockHealthSpawner(() => notRunning);
      const writes: Array<string> = [];
      const originalWrite = globalThis.process.stderr.write.bind(globalThis.process.stderr);
      globalThis.process.stderr.write = ((chunk: string | Uint8Array) => {
        writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
        return true;
      }) as typeof globalThis.process.stderr.write;

      try {
        const fiber = yield* legacyWaitForHealthyServices(mock.spawner, ["supabase_rest_proj"], {
          timeoutSeconds: 1,
        }).pipe(
          Effect.provide(unusedHttpClientLayer),
          Effect.forkChild({ startImmediately: true }),
        );

        yield* TestClock.adjust("1 seconds");
        yield* Fiber.await(fiber);
      } finally {
        globalThis.process.stderr.write = originalWrite;
      }

      expect(writes.some((chunk) => chunk.includes("supabase_rest_proj container logs:"))).toBe(
        true,
      );
      expect(
        mock.spawned.some((args) => args[0] === "logs" && args[1] === "supabase_rest_proj"),
      ).toBe(true);
    }),
  );

  it.effect(
    "suggests removing the exact cached image after an exec-format failure without deleting local data",
    () =>
      Effect.gen(function* () {
        const containerId = "supabase_inbucket_proj";
        const image = "public.ecr.aws/supabase/mailpit:v1.30.2";
        const mock = mockHealthSpawner(() => notRunning, {
          logs: { [containerId]: ["exec /mailpit: exec for", "mat error\n"] },
          images: { [containerId]: image },
        });

        const fiber = yield* legacyWaitForHealthyServices(mock.spawner, [containerId], {
          timeoutSeconds: 1,
          recovery: {
            workdir: "/tmp/project with spaces",
            platform: "linux",
          },
        }).pipe(
          Effect.provide(unusedHttpClientLayer),
          Effect.forkChild({ startImmediately: true }),
        );

        yield* TestClock.adjust("1 seconds");
        const error = yield* Fiber.join(fiber).pipe(Effect.flip);

        expect(error.message).toContain("cached Docker image");
        expect(error.message).toContain("supabase --workdir '/tmp/project with spaces' stop");
        expect(error.message).toContain(`docker image rm ${image}`);
        expect(error.message).toContain("supabase --workdir '/tmp/project with spaces' start");
        expect(error.message).not.toContain("stop --no-backup");
      }),
  );

  it.effect(
    "warns before suggesting a local-data reset for conflicting Storage migration state",
    () =>
      Effect.gen(function* () {
        const containerId = "supabase_storage_proj";
        const mock = mockHealthSpawner(() => runningStarting, {
          logs: {
            [containerId]:
              'Migration failed. Reason: duplicate key value violates unique constraint "migrations_name_key"\n',
          },
        });

        const fiber = yield* legacyWaitForHealthyServices(mock.spawner, [containerId], {
          timeoutSeconds: 1,
          recovery: {
            workdir: String.raw`C:\project files`,
            platform: "win32",
            storageContainerId: containerId,
          },
        }).pipe(
          Effect.provide(unusedHttpClientLayer),
          Effect.forkChild({ startImmediately: true }),
        );

        yield* TestClock.adjust("1 seconds");
        const error = yield* Fiber.join(fiber).pipe(Effect.flip);

        expect(error.message).toContain("Storage migration state");
        expect(error.message).toContain("deletes local database data");
        expect(error.message).toContain(
          String.raw`supabase --workdir "C:\project files" stop --no-backup`,
        );
        expect(error.message).toContain(String.raw`supabase --workdir "C:\project files" start`);
      }),
  );

  it.effect("does not suggest deleting data for incomplete or non-Storage migration errors", () =>
    Effect.gen(function* () {
      const storageId = "supabase_storage_proj";
      const restId = "supabase_rest_proj";
      const mock = mockHealthSpawner(() => runningStarting, {
        logs: {
          [storageId]: 'constraint "migrations_name_key" already exists\n',
          [restId]:
            'Migration failed. Reason: duplicate key value violates unique constraint "migrations_name_key"\n',
        },
      });

      const fiber = yield* legacyWaitForHealthyServices(mock.spawner, [storageId, restId], {
        timeoutSeconds: 1,
        recovery: {
          workdir: "/tmp/project",
          platform: "linux",
          storageContainerId: storageId,
        },
      }).pipe(Effect.provide(unusedHttpClientLayer), Effect.forkChild({ startImmediately: true }));

      yield* TestClock.adjust("1 seconds");
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);

      expect(error.message).not.toContain("Storage migration state");
      expect(error.message).not.toContain("--no-backup");
    }),
  );

  it.effect("omits a no-op recovery recipe when the affected image cannot be inspected", () =>
    Effect.gen(function* () {
      const containerId = "supabase_inbucket_proj";
      const mock = mockHealthSpawner(() => notRunning, {
        logs: { [containerId]: "exec /mailpit: exec format error\n" },
      });

      const fiber = yield* legacyWaitForHealthyServices(mock.spawner, [containerId], {
        timeoutSeconds: 1,
        recovery: {
          workdir: "/tmp/project",
          platform: "linux",
        },
      }).pipe(Effect.provide(unusedHttpClientLayer), Effect.forkChild({ startImmediately: true }));

      yield* TestClock.adjust("1 seconds");
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);

      expect(error.message).toContain("could not be determined automatically");
      expect(error.message).not.toContain("docker image rm");
      expect(error.message).not.toContain("supabase --workdir /tmp/project start");
    }),
  );

  it.effect(
    "combines image and Storage recovery into one ordered sequence and dedupes image references",
    () =>
      Effect.gen(function* () {
        const mailpitId = "supabase_inbucket_proj";
        const studioId = "supabase_studio_proj";
        const storageId = "supabase_storage_proj";
        const mailpitImage = "public.ecr.aws/supabase/mailpit:v1.30.2";
        const studioImage = "public.ecr.aws/supabase/studio:2026.07.13-sha-b5ada96";
        const mock = mockHealthSpawner(() => runningStarting, {
          logs: {
            [mailpitId]: "exec /mailpit: exec format error\n",
            [studioId]:
              "Error: Invalid package config /app/apps/studio/node_modules/next/package.json\n",
            [storageId]:
              'Migration failed. Reason: duplicate key value violates unique constraint "migrations_name_key"\n',
          },
          images: {
            [mailpitId]: mailpitImage,
            [studioId]: studioImage,
          },
        });

        const fiber = yield* legacyWaitForHealthyServices(
          mock.spawner,
          [mailpitId, studioId, storageId],
          {
            timeoutSeconds: 1,
            recovery: {
              workdir: "/tmp/project",
              platform: "linux",
              storageContainerId: storageId,
            },
          },
        ).pipe(Effect.provide(unusedHttpClientLayer), Effect.forkChild({ startImmediately: true }));

        yield* TestClock.adjust("1 seconds");
        const error = yield* Fiber.join(fiber).pipe(Effect.flip);

        expect(error.message).toContain("cached Docker images");
        expect(error.message).toContain("Storage migration state");
        expect(error.message).toContain("supabase --workdir /tmp/project stop --no-backup");
        expect(error.message).toContain(`docker image rm ${mailpitImage} ${studioImage}`);
        expect(error.message.match(/supabase --workdir \/tmp\/project start/gu)).toHaveLength(1);
      }),
  );

  it.effect("omits shell commands for Windows workdirs with expansion characters", () =>
    Effect.gen(function* () {
      const containerId = "supabase_inbucket_proj";
      const image = "public.ecr.aws/supabase/mailpit:v1.30.2";
      const mock = mockHealthSpawner(() => notRunning, {
        logs: { [containerId]: "exec /mailpit: exec format error\n" },
        images: { [containerId]: image },
      });

      const fiber = yield* legacyWaitForHealthyServices(mock.spawner, [containerId], {
        timeoutSeconds: 1,
        recovery: {
          workdir: String.raw`C:\%PROJECT%\app`,
          platform: "win32",
        },
      }).pipe(Effect.provide(unusedHttpClientLayer), Effect.forkChild({ startImmediately: true }));

      yield* TestClock.adjust("1 seconds");
      const error = yield* Fiber.join(fiber).pipe(Effect.flip);

      expect(error.message).toContain(`Affected Docker image: ${image}`);
      expect(error.message).toContain("could not be rendered safely");
      expect(error.message).not.toContain("supabase --workdir");
      expect(error.message).not.toContain("docker image rm");
    }),
  );

  describe("PostgREST HTTP-HEAD readiness", () => {
    function postgrestGateway(secretKey: string): LegacyHealthCheckPostgrestGateway {
      return {
        containerId: "supabase_rest_proj",
        apiExternalUrl: "http://127.0.0.1:54321",
        secretKey,
      };
    }

    function httpLayer(status: number, expectHeaders: (headers: Record<string, string>) => void) {
      return Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          expectHeaders({ ...request.headers });
          expect(request.method).toBe("HEAD");
          expect(request.url).toBe("http://127.0.0.1:54321/rest-admin/v1/ready");
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(null, { status })),
          );
        }),
      );
    }

    it.effect("bypasses the Docker healthcheck and succeeds on a 200 HEAD response", () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner(() => runningHealthy);
        const layer = httpLayer(200, (headers) => {
          expect(headers["apikey"]).toBe("sb_secret_local");
          expect(headers["authorization"]).toBeUndefined();
        });

        const exit = yield* legacyWaitForHealthyServices(mock.spawner, ["supabase_rest_proj"], {
          timeoutSeconds: 1,
          postgrest: postgrestGateway("sb_secret_local"),
        }).pipe(Effect.provide(layer), Effect.exit);

        expect(Exit.isSuccess(exit)).toBe(true);
        // Never falls back to the Docker healthcheck for PostgREST.
        expect(mock.spawned.some((args) => args[0] === "container" && args[1] === "inspect")).toBe(
          false,
        );
      }),
    );

    it.effect("sends both apikey and Authorization headers for a JWT secret key", () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner(() => runningHealthy);
        const layer = httpLayer(200, (headers) => {
          expect(headers["apikey"]).toBe("ey.jwt.key");
          expect(headers["authorization"]).toBe("Bearer ey.jwt.key");
        });

        const exit = yield* legacyWaitForHealthyServices(mock.spawner, ["supabase_rest_proj"], {
          timeoutSeconds: 1,
          postgrest: postgrestGateway("ey.jwt.key"),
        }).pipe(Effect.provide(layer), Effect.exit);

        expect(Exit.isSuccess(exit)).toBe(true);
      }),
    );

    it.effect("retries and eventually times out when PostgREST never returns 200", () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner(() => runningHealthy);
        const layer = httpLayer(503, () => {});

        const fiber = yield* legacyWaitForHealthyServices(mock.spawner, ["supabase_rest_proj"], {
          timeoutSeconds: 1,
          postgrest: postgrestGateway("sb_secret_local"),
        }).pipe(Effect.provide(layer), Effect.forkChild({ startImmediately: true }));

        yield* TestClock.adjust("1 seconds");
        const error = yield* Fiber.join(fiber).pipe(Effect.flip);

        expect(error).toBeInstanceOf(LegacyHealthCheckTimeoutError);
        expect(error.unhealthy).toEqual([
          { containerId: "supabase_rest_proj", reason: "unexpected status 503" },
        ]);
      }),
    );
  });

  describe("Edge Runtime HTTP-HEAD readiness", () => {
    function edgeRuntimeGateway(secretKey: string): LegacyHealthCheckPostgrestGateway {
      return {
        containerId: "supabase_edge_runtime_proj",
        apiExternalUrl: "http://127.0.0.1:54321",
        secretKey,
      };
    }

    function httpLayer(status: number, expectPath: string) {
      return Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          expect(request.method).toBe("HEAD");
          expect(request.url).toBe(`http://127.0.0.1:54321${expectPath}`);
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(null, { status })),
          );
        }),
      );
    }

    it.effect("bypasses the Docker healthcheck and succeeds on a 200 HEAD response", () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner(() => runningHealthy);
        const layer = httpLayer(200, "/functions/v1/_internal/health");

        const exit = yield* legacyWaitForHealthyServices(
          mock.spawner,
          ["supabase_edge_runtime_proj"],
          {
            timeoutSeconds: 1,
            edgeRuntime: edgeRuntimeGateway("sb_secret_local"),
          },
        ).pipe(Effect.provide(layer), Effect.exit);

        expect(Exit.isSuccess(exit)).toBe(true);
        // Never falls back to the Docker healthcheck for Edge Runtime.
        expect(mock.spawned.some((args) => args[0] === "container" && args[1] === "inspect")).toBe(
          false,
        );
      }),
    );

    it.effect("retries and eventually times out when Edge Runtime never returns 200", () =>
      Effect.gen(function* () {
        const mock = mockHealthSpawner(() => runningHealthy);
        const layer = httpLayer(503, "/functions/v1/_internal/health");

        const fiber = yield* legacyWaitForHealthyServices(
          mock.spawner,
          ["supabase_edge_runtime_proj"],
          {
            timeoutSeconds: 1,
            edgeRuntime: edgeRuntimeGateway("sb_secret_local"),
          },
        ).pipe(Effect.provide(layer), Effect.forkChild({ startImmediately: true }));

        yield* TestClock.adjust("1 seconds");
        const error = yield* Fiber.join(fiber).pipe(Effect.flip);

        expect(error).toBeInstanceOf(LegacyHealthCheckTimeoutError);
        expect(error.unhealthy).toEqual([
          { containerId: "supabase_edge_runtime_proj", reason: "unexpected status 503" },
        ]);
      }),
    );

    it.effect(
      "probes PostgREST and Edge Runtime on their own paths, and every other container via Docker",
      () =>
        Effect.gen(function* () {
          const mock = mockHealthSpawner(() => runningHealthy);
          const layer = Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              const url = new URL(request.url);
              expect(["/rest-admin/v1/ready", "/functions/v1/_internal/health"]).toContain(
                url.pathname,
              );
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(null, { status: 200 })),
              );
            }),
          );

          const exit = yield* legacyWaitForHealthyServices(
            mock.spawner,
            ["supabase_rest_proj", "supabase_edge_runtime_proj", "supabase_kong_proj"],
            {
              timeoutSeconds: 1,
              postgrest: {
                containerId: "supabase_rest_proj",
                apiExternalUrl: "http://127.0.0.1:54321",
                secretKey: "sb_secret_local",
              },
              edgeRuntime: edgeRuntimeGateway("sb_secret_local"),
            },
          ).pipe(Effect.provide(layer), Effect.exit);

          expect(Exit.isSuccess(exit)).toBe(true);
          expect(
            mock.spawned.some(
              (args) =>
                args[0] === "container" &&
                args[1] === "inspect" &&
                args[2] === "supabase_kong_proj",
            ),
          ).toBe(true);
          expect(
            mock.spawned.some(
              (args) =>
                args[0] === "container" &&
                args[1] === "inspect" &&
                args[2] === "supabase_rest_proj",
            ),
          ).toBe(false);
          expect(
            mock.spawned.some(
              (args) =>
                args[0] === "container" &&
                args[1] === "inspect" &&
                args[2] === "supabase_edge_runtime_proj",
            ),
          ).toBe(false);
        }),
    );
  });
});
