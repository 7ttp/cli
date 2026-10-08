import { Cause, Effect, Option, Runtime } from "effect";
import { isClosedStdioPipe } from "../runtime/process-control.layer.ts";
import { Output } from "./output.service.ts";
import { ProcessControl } from "../runtime/process-control.service.ts";
import { normalizeCliError } from "./normalize-error.ts";

export const withJsonErrorHandling = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A | void, E, R | Output | ProcessControl> =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        if (isClosedStdioPipe(cause)) return yield* Effect.failCause(cause);
        const failure = Cause.findErrorOption(cause);
        if (Option.isNone(failure)) return yield* Effect.failCause(cause);
        const error = failure.value;
        const output = yield* Output;
        const processControl = yield* ProcessControl;
        if (output.format === "text" || (yield* processControl.getExitCode) === 141) {
          return yield* Effect.failCause(cause);
        }
        yield* output.fail(normalizeCliError(error));
        // `Runtime.getErrorExitCode` defaults to 1 unless the error opts in via
        // `[Runtime.errorExitCode]`, so a delegated child's real exit code still
        // reaches the user under json/stream-json, matching the text-mode path.
        yield* processControl.setExitCode(Runtime.getErrorExitCode(error));
      }),
    ),
  );
