import type { EventEmitter } from "node:events";
import process from "node:process";
import { Cause, Effect, Layer, PlatformError, Predicate } from "effect";

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

/**
 * exitOnBrokenPipe - Exits with 141 (128 + SIGPIPE) on an EPIPE that no other `error` listener
 * handles, since Bun ignores SIGPIPE and later writes to the closed pipe never settle; other such
 * errors rethrow.
 */
export function exitOnBrokenPipe(
  streams: ReadonlyArray<EventEmitter>,
  exit: (code: number) => void,
): void {
  for (const stream of streams) {
    stream.on("error", (error: Error) => {
      if (stream.listenerCount("error") > 1) return;
      if (!("code" in error && error.code === "EPIPE")) throw error;
      exit(141);
    });
  }
}

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
