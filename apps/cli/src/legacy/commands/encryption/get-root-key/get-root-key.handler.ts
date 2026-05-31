import { Effect } from "effect";

import { LegacyPlatformApi } from "../../../auth/legacy-platform-api.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { mapLegacyHttpError } from "../../../shared/legacy-http-errors.ts";
import {
  LegacyEncryptionGetRootKeyNetworkError,
  LegacyEncryptionGetRootKeyUnexpectedStatusError,
} from "../encryption.errors.ts";
import type { LegacyEncryptionGetRootKeyFlags } from "./get-root-key.command.ts";

const mapGetRootKeyError = mapLegacyHttpError({
  networkError: LegacyEncryptionGetRootKeyNetworkError,
  statusError: LegacyEncryptionGetRootKeyUnexpectedStatusError,
  networkMessage: (cause) => `failed to retrieve pgsodium config: ${cause}`,
  statusMessage: (status, body) => `unexpected get pgsodium config status ${status}: ${body}`,
});

export const legacyEncryptionGetRootKey = Effect.fn("legacy.encryption.get-root-key")(function* (
  flags: LegacyEncryptionGetRootKeyFlags,
) {
  const output = yield* Output;
  const api = yield* LegacyPlatformApi;
  const resolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  const telemetryState = yield* LegacyTelemetryState;

  yield* Effect.gen(function* () {
    const ref = yield* resolver.resolve(flags.projectRef);

    yield* Effect.gen(function* () {
      const response = yield* api.v1
        .getPgsodiumConfig({ ref })
        .pipe(Effect.catch(mapGetRootKeyError));

      if (output.format === "json" || output.format === "stream-json") {
        yield* output.success("", response);
        return;
      }

      yield* output.raw(response.root_key + "\n");
    }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }).pipe(Effect.ensuring(telemetryState.flush));
});
