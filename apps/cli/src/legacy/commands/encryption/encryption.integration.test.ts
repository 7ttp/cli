import { styleText } from "node:util";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";
import { vi } from "vitest";

import { mockOutput, mockStdin, mockTty } from "../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  buildLegacyTestRuntime,
  legacyTransportFailure,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../tests/helpers/legacy-mocks.ts";
import { legacyEncryptionGetRootKey } from "./get-root-key/get-root-key.handler.ts";
import { legacyEncryptionUpdateRootKey } from "./update-root-key/update-root-key.handler.ts";

const tempRoot = useLegacyTempWorkdir("supabase-encryption-int-");

function runtimeWith(opts: {
  readonly out: ReturnType<typeof mockOutput>;
  readonly api: ReturnType<typeof mockLegacyPlatformApi>;
  readonly telemetry?: ReturnType<typeof mockLegacyTelemetryStateTracked>["layer"];
  readonly linkedProjectCache?: ReturnType<typeof mockLegacyLinkedProjectCacheTracked>["layer"];
  readonly tty?: ReturnType<typeof mockTty>;
}) {
  return buildLegacyTestRuntime({
    out: opts.out,
    api: opts.api,
    cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
    telemetry: opts.telemetry,
    linkedProjectCache: opts.linkedProjectCache,
    tty: opts.tty,
  });
}

describe("legacy encryption get-root-key", () => {
  it.live("prints the root key to stdout in text mode", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({
      response: { status: 200, body: { root_key: "test-key" } },
    });

    return Effect.gen(function* () {
      yield* legacyEncryptionGetRootKey({ projectRef: Option.none() }).pipe(
        Effect.provide(runtimeWith({ out, api })),
      );
      expect(out.stdoutText).toBe("test-key\n");
      expect(out.stderrText).toBe("");
      expect(api.requests[0]?.method).toBe("GET");
      expect(api.requests[0]?.url).toContain(`/v1/projects/${LEGACY_VALID_REF}/pgsodium`);
    });
  });

  it.live("emits a structured success payload for --output-format json", () => {
    const out = mockOutput({ format: "json" });
    const api = mockLegacyPlatformApi({
      response: { status: 200, body: { root_key: "test-key" } },
    });

    return Effect.gen(function* () {
      yield* legacyEncryptionGetRootKey({ projectRef: Option.none() }).pipe(
        Effect.provide(runtimeWith({ out, api })),
      );
      const success = out.messages.find((message) => message.type === "success");
      expect(success?.data).toEqual({ root_key: "test-key" });
    });
  });

  it.live("maps HTTP 503 to the get unexpected-status error", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 503, body: {} } });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyEncryptionGetRootKey({ projectRef: Option.none() }).pipe(
          Effect.provide(runtimeWith({ out, api })),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyEncryptionGetRootKeyUnexpectedStatusError");
        expect(errorJson).toContain("unexpected get pgsodium config status 503");
      }
    });
  });

  it.live("maps transport failures to the get network error", () => {
    const out = mockOutput({ format: "json" });
    const api = mockLegacyPlatformApi({ network: "fail" });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyEncryptionGetRootKey({ projectRef: Option.none() }).pipe(
          Effect.provide(runtimeWith({ out, api })),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyEncryptionGetRootKeyNetworkError");
        expect(errorJson).toContain("failed to retrieve pgsodium config");
      }
    });
  });
});

describe("legacy encryption update-root-key", () => {
  it.live("reads piped stdin, updates the root key, and preserves prompt/output bytes", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({
      response: { status: 200, body: { root_key: "test-key" } },
    });

    return Effect.gen(function* () {
      yield* legacyEncryptionUpdateRootKey({ projectRef: Option.none() }).pipe(
        Effect.provide(mockStdin(false, "test-key")),
        Effect.provide(runtimeWith({ out, api })),
      );

      expect(out.stderrText).toBe(
        `Enter a new root key: Finished ${styleText("cyan", "supabase root-key update")}.\n`,
      );
      expect(out.stdoutText).toBe("\n");
      expect(api.requests[0]?.method).toBe("PUT");
      expect(api.requests[0]?.url).toContain(`/v1/projects/${LEGACY_VALID_REF}/pgsodium`);
      expect(api.requests[0]?.body).toEqual({ root_key: "test-key" });
    }) as Effect.Effect<void, never, never>;
  });

  it.live("reads masked tty input and updates the root key", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({
      response: { status: 200, body: { root_key: "tty-key" } },
    });
    const tty = mockTty({ stdinIsTty: true, stdoutIsTty: false });
    const originalSetRawMode = process.stdin.setRawMode;
    const originalResume = process.stdin.resume;
    const originalPause = process.stdin.pause;
    const setRawMode = vi.fn();
    const resume = vi.fn(() => process.stdin);
    const pause = vi.fn(() => process.stdin);
    process.stdin.setRawMode = setRawMode as typeof process.stdin.setRawMode;
    process.stdin.resume = resume as typeof process.stdin.resume;
    process.stdin.pause = pause as typeof process.stdin.pause;

    return Effect.gen(function* () {
      const timer = setTimeout(() => {
        process.stdin.emit("data", Buffer.from("tty-key\r"));
      }, 0);

      try {
        yield* legacyEncryptionUpdateRootKey({ projectRef: Option.none() }).pipe(
          Effect.provide(mockStdin(true)),
          Effect.provide(runtimeWith({ out, api, tty })),
        );
      } finally {
        clearTimeout(timer);
        process.stdin.setRawMode = originalSetRawMode;
        process.stdin.resume = originalResume;
        process.stdin.pause = originalPause;
      }

      expect(setRawMode).toHaveBeenNthCalledWith(1, true);
      expect(setRawMode).toHaveBeenNthCalledWith(2, false);
      expect(out.stderrText).toBe(
        `Enter a new root key: Finished ${styleText("cyan", "supabase root-key update")}.\n`,
      );
      expect(out.stdoutText).toBe("\n");
      expect(api.requests[0]?.body).toEqual({ root_key: "tty-key" });
    }) as Effect.Effect<void, never, never>;
  });

  it.live("emits a structured success payload for --output-format json", () => {
    const out = mockOutput({ format: "json" });
    const api = mockLegacyPlatformApi({
      response: { status: 200, body: { root_key: "test-key" } },
    });

    return Effect.gen(function* () {
      yield* legacyEncryptionUpdateRootKey({ projectRef: Option.none() }).pipe(
        Effect.provide(mockStdin(false, "test-key")),
        Effect.provide(runtimeWith({ out, api })),
      );
      const success = out.messages.find((message) => message.type === "success");
      expect(success?.data).toEqual({ root_key: "test-key" });
      expect(out.stderrText).toBe("Enter a new root key: ");
      expect(out.stdoutText).toBe("");
    }) as Effect.Effect<void, never, never>;
  });

  it.live("emits a structured success payload for --output-format stream-json", () => {
    const out = mockOutput({ format: "stream-json" });
    const api = mockLegacyPlatformApi({
      response: { status: 200, body: { root_key: "test-key" } },
    });

    return Effect.gen(function* () {
      yield* legacyEncryptionUpdateRootKey({ projectRef: Option.none() }).pipe(
        Effect.provide(mockStdin(false, "test-key")),
        Effect.provide(runtimeWith({ out, api })),
      );
      const success = out.messages.find((message) => message.type === "success");
      expect(success?.data).toEqual({ root_key: "test-key" });
      expect(out.stderrText).toBe("Enter a new root key: ");
      expect(out.stdoutText).toBe("");
    }) as Effect.Effect<void, never, never>;
  });

  it.live("flushes telemetry and caches the ref when update fails after resolution", () => {
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 503, body: {} } });
    const telemetry = mockLegacyTelemetryStateTracked();
    const cache = mockLegacyLinkedProjectCacheTracked();

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyEncryptionUpdateRootKey({ projectRef: Option.none() }).pipe(
          Effect.provide(mockStdin(false, "test-key")),
          Effect.provide(
            runtimeWith({
              out,
              api,
              telemetry: telemetry.layer,
              linkedProjectCache: cache.layer,
            }),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyEncryptionUpdateRootKeyUnexpectedStatusError");
      }
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }) as Effect.Effect<void, never, never>;
  });

  it.live("maps transport failures to the update network error", () => {
    const out = mockOutput({ format: "json" });
    const api = mockLegacyPlatformApi({
      handler: (request) => Effect.fail(legacyTransportFailure(request)),
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyEncryptionUpdateRootKey({ projectRef: Option.none() }).pipe(
          Effect.provide(mockStdin(false, "test-key")),
          Effect.provide(runtimeWith({ out, api })),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyEncryptionUpdateRootKeyNetworkError");
        expect(errorJson).toContain("failed to update pgsodium config");
      }
    }) as Effect.Effect<void, never, never>;
  });
});
