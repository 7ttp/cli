import { styleText } from "node:util";
import { Effect, Option } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { Stdin } from "../../../../shared/runtime/stdin.service.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import {
  LegacyEncryptionUpdateRootKeyNetworkError,
  LegacyEncryptionUpdateRootKeyUnexpectedStatusError,
} from "../encryption.errors.ts";
import type { LegacyEncryptionUpdateRootKeyFlags } from "./update-root-key.command.ts";

const mapUpdateRootKeyError = mapLegacyHttpError({
  networkError: LegacyEncryptionUpdateRootKeyNetworkError,
  statusError: LegacyEncryptionUpdateRootKeyUnexpectedStatusError,
  networkMessage: (cause) => `failed to update pgsodium config: ${cause}`,
  statusMessage: (status, body) => `unexpected update pgsodium config status ${status}: ${body}`,
});

function readMaskedInputFromTty(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const chunks: Buffer[] = [];

    const cleanup = () => {
      stdin.off("data", onData);
      if (typeof stdin.setRawMode === "function") {
        stdin.setRawMode(false);
      }
      stdin.pause();
    };

    const finish = () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };

    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (const byte of buffer) {
        if (byte === 0x0d || byte === 0x0a) {
          finish();
          return;
        }
        if (byte === 0x03) {
          finish();
          return;
        }
        if (byte === 0x08 || byte === 0x7f) {
          if (chunks.length > 0) {
            const current = Buffer.concat(chunks);
            chunks.length = 0;
            if (current.length > 0) {
              chunks.push(current.subarray(0, current.length - 1));
            }
          }
          continue;
        }
        chunks.push(Buffer.from([byte]));
      }
    };

    if (typeof stdin.setRawMode === "function") {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.on("data", onData);
  });
}

const readRootKeyInput = Effect.fn("legacy.encryption.update-root-key.read-input")(function* () {
  const output = yield* Output;
  const stdin = yield* Stdin;

  yield* output.raw("Enter a new root key: ", "stderr");

  const value = stdin.isTTY
    ? yield* Effect.promise(() => readMaskedInputFromTty()).pipe(
        Effect.catch((cause) =>
          Effect.gen(function* () {
            yield* output.raw(`Failed to read password: ${String(cause)}\n`, "stderr");
            return "";
          }),
        ),
      )
    : yield* stdin.readPipedBytes.pipe(
        Effect.map((bytes) => (Option.isSome(bytes) ? new TextDecoder().decode(bytes.value) : "")),
      );

  if (output.format === "text") {
    yield* output.raw("\n");
  }
  return value.trim();
});

export const legacyEncryptionUpdateRootKey = Effect.fn("legacy.encryption.update-root-key")(
  function* (flags: LegacyEncryptionUpdateRootKeyFlags) {
    const output = yield* Output;
    const api = yield* LegacyPlatformApi;
    const resolver = yield* LegacyProjectRefResolver;
    const linkedProjectCache = yield* LegacyLinkedProjectCache;
    const telemetryState = yield* LegacyTelemetryState;

    yield* Effect.gen(function* () {
      const ref = yield* resolver.resolve(flags.projectRef);

      yield* Effect.gen(function* () {
        const rootKey = yield* readRootKeyInput();
        const response = yield* api.v1
          .updatePgsodiumConfig({ ref, root_key: rootKey })
          .pipe(Effect.catch(mapUpdateRootKeyError));

        if (output.format === "json" || output.format === "stream-json") {
          yield* output.success("", response);
          return;
        }

        yield* output.raw(`Finished ${styleText("cyan", "supabase root-key update")}.\n`, "stderr");
      }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
    }).pipe(Effect.ensuring(telemetryState.flush));
  },
);
