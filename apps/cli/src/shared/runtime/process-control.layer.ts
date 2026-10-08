import type { EventEmitter } from "node:events";
import process from "node:process";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  PlatformError,
  Predicate,
} from "effect";

import { ProcessControl, type CliProcessSignal } from "./process-control.service.ts";

const defaultSignals: ReadonlyArray<CliProcessSignal> = ["SIGINT", "SIGTERM"];

/**
 * processControlLayer - Node process lifecycle wiring.
 *
 * This layer translates OS signals and shutdown events into Effect values so
 * command code can coordinate cancellation and exit behavior without touching
 * `process` directly.
 */
export const processControlLayer = Layer.sync(ProcessControl, () =>
  ProcessControl.of({
    awaitSignal: (signals = defaultSignals) =>
      Effect.callback<CliProcessSignal>((resume) => {
        const cleanup = () => {
          for (const signal of signals) {
            process.off(signal, listeners[signal]);
          }
        };

        const listeners = Object.fromEntries(
          signals.map((signal) => [
            signal,
            () => {
              cleanup();
              resume(Effect.succeed(signal));
            },
          ]),
        ) as Record<CliProcessSignal, () => void>;

        for (const signal of signals) {
          process.once(signal, listeners[signal]);
        }

        return Effect.sync(cleanup);
      }),
    // `awaitShutdown` also listens for stdin closure so piped invocations can terminate cleanly.
    awaitShutdown: Effect.callback<void>((resume) => {
      const onShutdown = () => {
        cleanup();
        resume(Effect.void);
      };

      const cleanup = () => {
        process.off("SIGTERM", onShutdown);
        process.off("SIGINT", onShutdown);
        process.stdin.off("end", onShutdown);
        process.stdin.off("close", onShutdown);
      };

      process.once("SIGTERM", onShutdown);
      process.once("SIGINT", onShutdown);
      if (process.stdin.readable) {
        process.stdin.resume();
        process.stdin.once("end", onShutdown);
        process.stdin.once("close", onShutdown);
      }

      return Effect.sync(cleanup);
    }),
    // No-op listener per signal for the scope's lifetime; see
    // `ProcessControlShape.holdSignals` for why.
    holdSignals: (signals) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const noop = () => {};
          for (const signal of signals) {
            process.on(signal, noop);
          }
          return noop;
        }),
        (noop) =>
          Effect.sync(() => {
            for (const signal of signals) {
              process.removeListener(signal, noop);
            }
          }),
      ).pipe(Effect.asVoid),
    exit: (code: number) => Effect.sync(() => process.exit(hasBrokenProcessPipe() ? 141 : code)),
    setExitCode: (code: number) =>
      Effect.sync(() => {
        process.exitCode = code;
      }),
    getExitCode: Effect.sync(() => {
      if (hasBrokenProcessPipe()) return 141;
      const exitCode = process.exitCode;
      return typeof exitCode === "number" ? exitCode : undefined;
    }),
  }),
);

/** Installs the early-entrypoint fallback; remove it before Effect owns command cleanup. */
export function exitOnBrokenPipe(
  streams: ReadonlyArray<EventEmitter>,
  exit: (code: number) => void,
): () => void {
  const listeners = streams.map((stream) => {
    const listener = (error: Error) => {
      if (stream.listenerCount("error") > 1) return;
      if (!("code" in error && error.code === "EPIPE")) throw error;
      exit(141);
    };
    stream.on("error", listener);
    return () => stream.off("error", listener);
  });
  return () => {
    for (const remove of listeners) remove();
  };
}

class ClosedStdioPipe extends Context.Service<
  ClosedStdioPipe,
  {
    readonly observed: Effect.Effect<boolean>;
  }
>()("supabase/runtime/ClosedStdioPipe") {}

/** Whether this execution has observed a native stdout/stderr EPIPE. */
export const hasClosedStdioPipe = Effect.gen(function* () {
  const pipe = yield* Effect.serviceOption(ClosedStdioPipe);
  return Option.isSome(pipe) ? yield* pipe.value.observed : hasBrokenProcessPipe();
});

/** Owns stdio error listeners until the command and its scoped cleanup finish. */
export const withStdioPipeHandling = <A, E, R>(
  self: Effect.Effect<A, E, R>,
  streams: Readonly<Record<"stdout" | "stderr", EventEmitter>> = process,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const pipe = yield* Deferred.make<PlatformError.PlatformError>();
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const methods: ReadonlyArray<"stdout" | "stderr"> = ["stdout", "stderr"];
          return methods.map((method) => {
            const stream = streams[method];
            const listener = (error: unknown) => {
              if (isBrokenPipeError(error)) {
                Deferred.doneUnsafe(
                  pipe,
                  Effect.succeed(
                    PlatformError.systemError({
                      module: "Stdio",
                      method,
                      _tag: "Unknown",
                      cause: error,
                    }),
                  ),
                );
              } else if (stream.listenerCount("error") === 1) {
                throw error;
              }
            };
            stream.on("error", listener);
            return () => stream.off("error", listener);
          });
        }),
        (listeners) =>
          Effect.sync(() => {
            for (const remove of listeners) remove();
          }),
      );
      const task = yield* self.pipe(
        Effect.provideService(ClosedStdioPipe, { observed: Deferred.isDone(pipe) }),
        Effect.forkScoped,
      );
      const outcome = yield* Effect.raceFirst(
        Fiber.await(task).pipe(Effect.map(Option.some)),
        Deferred.await(pipe).pipe(Effect.as(Option.none())),
      );
      if (Option.isNone(outcome)) yield* Fiber.interrupt(task);
      const exit = Option.isSome(outcome) ? outcome.value : yield* Fiber.await(task);
      if (yield* Deferred.isDone(pipe)) {
        const error = yield* Deferred.await(pipe);
        return yield* Effect.failCause(
          Exit.isFailure(exit) ? Cause.combine(exit.cause, Cause.fail(error)) : Cause.fail(error),
        );
      }
      return yield* exit;
    }),
  ).pipe(Effect.withSpan("ProcessControl.stdio"));

// Best-effort diagnostics can consume the Effect failure, but the native stream retains it.
function hasBrokenProcessPipe(): boolean {
  return [process.stdout, process.stderr].some((stream) => isBrokenPipeError(stream.errored));
}

function isBrokenPipeError(error: unknown): boolean {
  return Predicate.hasProperty(error, "code") && error.code === "EPIPE";
}

/** Whether any failure or defect records a stdout/stderr EPIPE. */
export function isClosedStdioPipe(cause: Cause.Cause<unknown>): boolean {
  return cause.reasons.some((reason) => {
    const error = Cause.isFailReason(reason)
      ? reason.error
      : Cause.isDieReason(reason)
        ? reason.defect
        : undefined;
    return (
      error instanceof PlatformError.PlatformError &&
      error.reason.module === "Stdio" &&
      (error.reason.method === "stdout" || error.reason.method === "stderr") &&
      isBrokenPipeError(error.cause)
    );
  });
}
