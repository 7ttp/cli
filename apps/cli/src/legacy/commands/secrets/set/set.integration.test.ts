import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";

import {
  mockOutput,
  mockRuntimeInfo,
  processEnvLayer,
} from "../../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  buildLegacyTestRuntime,
  mockLegacyCliConfig,
  mockLegacyPlatformApi,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { LegacyDebugLogger } from "../../../shared/legacy-debug-logger.service.ts";
import { legacySecretsSet } from "./set.handler.ts";

function mockLegacyDebugLoggerTracked() {
  const messages: Array<string> = [];
  return {
    messages,
    layer: Layer.succeed(LegacyDebugLogger, {
      debug: (message) =>
        Effect.sync(() => {
          messages.push(message);
        }),
      http: () => Effect.void,
    }),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  goOutput?: "pretty" | "json" | "yaml" | "toml" | "env";
  status?: number;
  network?: "fail";
  env?: Record<string, string | undefined>;
}

const tempRoot = useLegacyTempWorkdir("supabase-secrets-set-int-");

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockLegacyPlatformApi({
    // POST `/v1/projects/{ref}/secrets` returns 201 with no body on success.
    response: { status: opts.status ?? 201, body: null },
    network: opts.network,
  });
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
  const debugLogger = mockLegacyDebugLoggerTracked();
  const layer = Layer.mergeAll(
    buildLegacyTestRuntime({
      out,
      api,
      cliConfig,
      goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
    }),
    mockRuntimeInfo({ cwd: tempRoot.current }),
    processEnvLayer(opts.env ?? {}),
    debugLogger.layer,
  );
  return { layer, out, api, debugLogger };
}

function writeConfig(content: string) {
  mkdirSync(join(tempRoot.current, "supabase"), { recursive: true });
  writeFileSync(join(tempRoot.current, "supabase", "config.toml"), content);
}

function parsePostBody(body: unknown): Array<{ name: string; value: string }> {
  // `mockLegacyPlatformApi` JSON-decodes the request body when it parses; this
  // helper just narrows the type for the test assertions.
  return body as Array<{ name: string; value: string }>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("legacy secrets set integration", () => {
  it.live("sets a single secret via CLI arg FOO=bar", () => {
    const { layer, out, api } = setup();
    return Effect.gen(function* () {
      yield* legacySecretsSet({
        projectRef: Option.none(),
        envFile: Option.none(),
        secrets: ["FOO=bar"],
      });
      expect(api.requests).toHaveLength(1);
      expect(parsePostBody(api.requests[0]!.body)).toEqual([{ name: "FOO", value: "bar" }]);
      expect(out.stdoutText).toBe("Finished supabase secrets set.\n");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "ignores [edge_runtime.secrets] from config.toml — explicit inputs only (supabase/supabase#45242)",
    () => {
      writeConfig('[edge_runtime.secrets]\nFOO = "foo"\n');
      const { layer, out, api } = setup();
      return Effect.gen(function* () {
        yield* legacySecretsSet({
          projectRef: Option.none(),
          envFile: Option.none(),
          secrets: ["BAR=bar"],
        });
        // The payload must contain ONLY the explicit arg — never config secrets,
        // which previously rode along and produced duplicate remote entries.
        expect(api.requests).toHaveLength(1);
        expect(parsePostBody(api.requests[0]!.body)).toEqual([{ name: "BAR", value: "bar" }]);
        // The silent behavior change gets a stderr breadcrumb (exit 0, but the
        // config secrets that used to ride along are no longer uploaded).
        expect(out.stderrText).toContain("[edge_runtime.secrets] in supabase/config.toml");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live(
    "bare secrets set fails with the no-arguments error even when config declares secrets",
    () => {
      writeConfig('[edge_runtime.secrets]\nFOO = "foo"\n');
      const { layer, api } = setup();
      return Effect.gen(function* () {
        const exit = yield* legacySecretsSet({
          projectRef: Option.none(),
          envFile: Option.none(),
          secrets: [],
        }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(api.requests).toHaveLength(0);
        // The error explains WHY config-declared secrets no longer count as input.
        const error = Exit.isFailure(exit)
          ? exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
          : undefined;
        expect((error as { message: string }).message).toContain(
          "not uploaded by secrets set — pass secrets explicitly",
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("sets multiple secrets via CLI args", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySecretsSet({
        projectRef: Option.none(),
        envFile: Option.none(),
        secrets: ["FOO=bar", "BAZ=qux"],
      });
      const body = parsePostBody(api.requests[0]!.body);
      expect(body).toEqual(
        expect.arrayContaining([
          { name: "FOO", value: "bar" },
          { name: "BAZ", value: "qux" },
        ]),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("batches large secret sets into requests of at most 100", () => {
    const { layer, out, api } = setup();
    return Effect.gen(function* () {
      yield* legacySecretsSet({
        projectRef: Option.none(),
        envFile: Option.none(),
        secrets: Array.from({ length: 150 }, (_, i) => `KEY${i}=value${i}`),
      });
      expect(api.requests).toHaveLength(2);
      const first = parsePostBody(api.requests[0]!.body);
      const second = parsePostBody(api.requests[1]!.body);
      expect(first).toHaveLength(100);
      expect(second).toHaveLength(50);
      const names = new Set([...first, ...second].map((entry) => entry.name));
      for (let i = 0; i < 150; i++) {
        expect(names.has(`KEY${i}`)).toBe(true);
      }
      expect(out.stdoutText).toContain("Finished supabase secrets set.");
    }).pipe(Effect.provide(layer));
  });

  it.live("batches 250 secrets into three requests (100/100/50)", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySecretsSet({
        projectRef: Option.none(),
        envFile: Option.none(),
        secrets: Array.from({ length: 250 }, (_, i) => `KEY${i}=value${i}`),
      });
      expect(api.requests).toHaveLength(3);
      expect(parsePostBody(api.requests[0]!.body)).toHaveLength(100);
      expect(parsePostBody(api.requests[1]!.body)).toHaveLength(100);
      expect(parsePostBody(api.requests[2]!.body)).toHaveLength(50);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "rejects the whole upload when a later batch has an invalid entry (no partial update)",
    () => {
      const { layer, api } = setup();
      // Index 120 lands in the SECOND batch (batch 0 covers indices 0-99): a
      // value exceeding the 24576-byte cap there must fail up-front validation
      // before batch 0 (which is otherwise entirely valid) is ever sent.
      const secrets = Array.from({ length: 150 }, (_, i) =>
        i === 120 ? `KEY${i}=${"x".repeat(24577)}` : `KEY${i}=value${i}`,
      );
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySecretsSet({
            projectRef: Option.none(),
            envFile: Option.none(),
            secrets,
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("sets secrets from --env-file with a relative path (joined to CWD)", () => {
    writeFileSync(join(tempRoot.current, "myfile.env"), "FROM_FILE=fromvalue\n");
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySecretsSet({
        projectRef: Option.none(),
        envFile: Option.some("myfile.env"),
        secrets: [],
      });
      expect(parsePostBody(api.requests[0]!.body)).toEqual([
        { name: "FROM_FILE", value: "fromvalue" },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.live("sets secrets from --env-file with an absolute path", () => {
    const abs = join(tempRoot.current, "absolute.env");
    writeFileSync(abs, "ABS=value\n");
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySecretsSet({
        projectRef: Option.none(),
        envFile: Option.some(abs),
        secrets: [],
      });
      expect(parsePostBody(api.requests[0]!.body)).toEqual([{ name: "ABS", value: "value" }]);
    }).pipe(Effect.provide(layer));
  });

  it.live("CLI args override --env-file entries for the same key", () => {
    writeFileSync(join(tempRoot.current, "override.env"), "FOO=from-file\n");
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacySecretsSet({
        projectRef: Option.none(),
        envFile: Option.some("override.env"),
        secrets: ["FOO=from-arg"],
      });
      expect(parsePostBody(api.requests[0]!.body)).toEqual([{ name: "FOO", value: "from-arg" }]);
    }).pipe(Effect.provide(layer));
  });

  it.live("skips SUPABASE_-prefixed entries with a stderr warning", () => {
    const { layer, out, api } = setup();
    return Effect.gen(function* () {
      yield* legacySecretsSet({
        projectRef: Option.none(),
        envFile: Option.none(),
        secrets: ["FOO=bar", "SUPABASE_BAD=x"],
      });
      const body = parsePostBody(api.requests[0]!.body);
      expect(body).toEqual([{ name: "FOO", value: "bar" }]);
      expect(out.stderrText).toContain(
        "Env name cannot start with SUPABASE_, skipping: SUPABASE_BAD",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "fails with LegacySecretsNoArgumentsError when args and env-file produce zero non-SUPABASE_ entries",
    () => {
      const { layer, api } = setup();
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySecretsSet({
            projectRef: Option.none(),
            envFile: Option.none(),
            secrets: ["SUPABASE_ONLY=x"],
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("LegacySecretsNoArgumentsError");
        }
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("fails with LegacyInvalidSecretPairError when an arg has no `=`", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySecretsSet({
          projectRef: Option.none(),
          envFile: Option.none(),
          secrets: ["NOTAPAIR"],
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("LegacyInvalidSecretPairError");
        expect(errJson).toContain("Invalid secret pair: NOTAPAIR");
      }
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacySecretsEnvFileOpenError when env-file does not exist", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySecretsSet({
          projectRef: Option.none(),
          envFile: Option.some("does-not-exist.env"),
          secrets: [],
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("LegacySecretsEnvFileOpenError");
        expect(errJson).toContain("failed to open env file");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "still fails with LegacySecretsNoArgumentsError when a malformed config leaves zero secret sources",
    () => {
      writeConfig("this is not valid = = toml [[[\n");
      const { layer, api } = setup();
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          legacySecretsSet({
            projectRef: Option.none(),
            envFile: Option.none(),
            secrets: [],
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("LegacySecretsNoArgumentsError");
        }
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("fails with LegacySecretsSetNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySecretsSet({
          projectRef: Option.none(),
          envFile: Option.none(),
          secrets: ["FOO=bar"],
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("LegacySecretsSetNetworkError");
        expect(errJson).toContain("failed to set secrets");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacySecretsSetUnexpectedStatusError on HTTP 500", () => {
    const { layer } = setup({ status: 500 });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacySecretsSet({
          projectRef: Option.none(),
          envFile: Option.none(),
          secrets: ["FOO=bar"],
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errJson = JSON.stringify(exit.cause);
        expect(errJson).toContain("LegacySecretsSetUnexpectedStatusError");
        expect(errJson).toContain("Unexpected error setting project secrets");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a success event with { project_ref, count } for --output-format=json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacySecretsSet({
        projectRef: Option.none(),
        envFile: Option.none(),
        secrets: ["FOO=bar", "BAZ=qux"],
      });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toEqual({ project_ref: LEGACY_VALID_REF, count: 2 });
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "text mode prints `Finished supabase secrets set.\\n` regardless of --output value",
    () => {
      const { layer, out } = setup({ goOutput: "json" });
      return Effect.gen(function* () {
        yield* legacySecretsSet({
          projectRef: Option.none(),
          envFile: Option.none(),
          secrets: ["FOO=bar"],
        });
        // Go ignores `--output` for `set` (set.go:42) — text-mode message lands regardless.
        expect(out.stdoutText).toBe("Finished supabase secrets set.\n");
      }).pipe(Effect.provide(layer));
    },
  );
});
