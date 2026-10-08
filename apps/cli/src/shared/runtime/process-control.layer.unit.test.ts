import process from "node:process";
import * as BunSink from "@effect/platform-bun/BunSink";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, PlatformError, Scope, Stream } from "effect";
import { ProcessControl } from "./process-control.service.ts";
import {
  exitOnBrokenPipe,
  processControlLayer,
  withStdioPipeHandling,
  isClosedStdioPipe,
  hasClosedStdioPipe,
} from "./process-control.layer.ts";

describe("ProcessControl", () => {
  it.effect("awaitSignal resolves when the requested signal is emitted", () =>
    Effect.gen(function* () {
      const processControl = yield* ProcessControl;
      const fiber = yield* processControl
        .awaitSignal(["SIGINT"])
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.sync(() => {
        process.emit("SIGINT");
      });
      const signal = yield* Fiber.join(fiber);
      expect(signal).toBe("SIGINT");
    }).pipe(Effect.provide(processControlLayer)),
  );

  it.effect("holdSignals remains installed after awaitSignal resolves", () =>
    Effect.gen(function* () {
      const processControl = yield* ProcessControl;
      const before = process.listenerCount("SIGINT");

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* processControl.holdSignals(["SIGINT"]);
          const fiber = yield* processControl
            .awaitSignal(["SIGINT"])
            .pipe(Effect.forkChild({ startImmediately: true }));

          expect(process.listenerCount("SIGINT") - before).toBe(2);
          yield* Effect.sync(() => {
            process.emit("SIGINT");
          });
          expect(yield* Fiber.join(fiber)).toBe("SIGINT");
          expect(process.listenerCount("SIGINT") - before).toBe(1);
        }),
      );

      expect(process.listenerCount("SIGINT")).toBe(before);
    }).pipe(Effect.provide(processControlLayer)),
  );

  it.effect("getExitCode returns the value previously set via setExitCode", () =>
    Effect.gen(function* () {
      const processControl = yield* ProcessControl;
      const initialExitCode = yield* processControl.getExitCode;
      expect(initialExitCode).toBe(process.exitCode);

      yield* processControl.setExitCode(23);
      const updatedExitCode = yield* processControl.getExitCode;
      expect(updatedExitCode).toBe(23);
    }).pipe(Effect.provide(processControlLayer)),
  );

  it.effect(
    "holdSignals installs listeners while the scope is open and removes them on close",
    () =>
      Effect.gen(function* () {
        const processControl = yield* ProcessControl;
        const before = {
          SIGINT: process.listenerCount("SIGINT"),
          SIGTERM: process.listenerCount("SIGTERM"),
          SIGHUP: process.listenerCount("SIGHUP"),
        };

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* processControl.holdSignals(["SIGINT", "SIGTERM", "SIGHUP"]);
            expect(process.listenerCount("SIGINT") - before.SIGINT).toBe(1);
            expect(process.listenerCount("SIGTERM") - before.SIGTERM).toBe(1);
            expect(process.listenerCount("SIGHUP") - before.SIGHUP).toBe(1);
          }),
        );

        expect(process.listenerCount("SIGINT")).toBe(before.SIGINT);
        expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM);
        expect(process.listenerCount("SIGHUP")).toBe(before.SIGHUP);
      }).pipe(Effect.provide(processControlLayer)),
  );

  it.effect("holdSignals removes listeners when its parent fiber is interrupted", () =>
    Effect.gen(function* () {
      const processControl = yield* ProcessControl;
      const before = {
        SIGINT: process.listenerCount("SIGINT"),
        SIGTERM: process.listenerCount("SIGTERM"),
      };

      const ready = Deferred.makeUnsafe<void>();
      const fiber = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* processControl.holdSignals(["SIGINT", "SIGTERM"]);
          yield* Effect.sync(() => Deferred.doneUnsafe(ready, Effect.void));
          return yield* Effect.never;
        }),
      ).pipe(Effect.forkChild({ startImmediately: true }));

      yield* Deferred.await(ready);
      expect(process.listenerCount("SIGINT") - before.SIGINT).toBe(1);
      expect(process.listenerCount("SIGTERM") - before.SIGTERM).toBe(1);

      yield* Fiber.interrupt(fiber);

      expect(process.listenerCount("SIGINT")).toBe(before.SIGINT);
      expect(process.listenerCount("SIGTERM")).toBe(before.SIGTERM);
    }).pipe(Effect.provide(processControlLayer)),
  );

  it.effect("holdSignals listeners are no-ops (signal emission does not resolve)", () =>
    Effect.gen(function* () {
      const processControl = yield* ProcessControl;
      const scope = yield* Scope.make();

      yield* processControl.holdSignals(["SIGINT"]).pipe(Scope.provide(scope));

      // Reaching the next line without the process dying is itself the
      // assertion: with no listener, SIGINT's default action would exit.
      yield* Effect.sync(() => {
        process.emit("SIGINT");
      });

      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(processControlLayer)),
  );
});

describe("exitOnBrokenPipe", () => {
  const writeError = (code: string) => Object.assign(new Error(`write ${code}`), { code });

  const guardedStream = () => {
    const stream = new PassThrough();
    const exits: Array<number> = [];
    const removeGuard = exitOnBrokenPipe([stream], (code) => exits.push(code));
    return { stream, exits, removeGuard };
  };

  it.effect("exits with 141 when nothing else handles an EPIPE on stdout or stderr", () =>
    Effect.sync(() => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const exits: Array<number> = [];
      exitOnBrokenPipe([stdout, stderr], (code) => exits.push(code));

      stdout.emit("error", writeError("EPIPE"));
      stderr.emit("error", writeError("EPIPE"));

      expect(exits).toEqual([141, 141]);
    }),
  );

  it.effect.each(["EPIPE", "ENOSPC"])("leaves %s to another error listener", (code) =>
    Effect.sync(() => {
      const { stream, exits, removeGuard } = guardedStream();
      const handled: Array<unknown> = [];
      stream.on("error", (error) => handled.push(error));
      const error = writeError(code);

      expect(() => stream.emit("error", error)).not.toThrow();
      expect(handled).toEqual([error]);
      expect(exits).toEqual([]);
      removeGuard();
      expect(stream.listenerCount("error")).toBe(1);
      stream.emit("error", error);
      expect(handled).toEqual([error, error]);
    }),
  );

  it.effect("rethrows any other stream error that nothing else handles", () =>
    Effect.sync(() => {
      const { stream, exits } = guardedStream();
      const error = writeError("ENOSPC");

      expect(() => stream.emit("error", error)).toThrow(error);
      expect(exits).toEqual([]);
    }),
  );
});

describe("stdio writable failures", () => {
  it.effect.each(["EPIPE", "ENOSPC"])(
    "a subsequent write retains the observed %s instead of waiting for drain",
    (code) =>
      Effect.gen(function* () {
        const error = Object.assign(new Error(`write ${code}`), { code });
        const writable = new Writable({
          write(_chunk, _encoding, callback) {
            callback(error);
          },
        });
        const sink = BunSink.fromWritable({
          evaluate: () => writable,
          onError: (failure) => failure,
          endOnDone: false,
        });
        const first = yield* Stream.make("first").pipe(Stream.run(sink), Effect.exit);
        expect(first).toEqual(Exit.fail(error));
        expect(writable.errored).toBe(error);
        const second = yield* Stream.make("second").pipe(Stream.run(sink), Effect.exit);
        expect(second).toEqual(Exit.fail(error));
      }),
  );
});

describe("scoped stdio pipe handling", () => {
  it.effect.each(["stdout", "stderr"] as const)(
    "cancels on a deferred %s write error and retains listeners through cleanup",
    (method) =>
      Effect.gen(function* () {
        const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
        const cleanupStarted = yield* Deferred.make<void>();
        const releaseCleanup = yield* Deferred.make<void>();
        const events: string[] = [];
        const stream = new Writable({
          write(_chunk, _encoding, callback) {
            queueMicrotask(() => callback(error));
          },
        });
        const other = new PassThrough();
        const streams =
          method === "stdout"
            ? { stdout: stream, stderr: other }
            : { stdout: other, stderr: stream };
        const sink = BunSink.fromWritable({
          evaluate: () => stream,
          onError: (cause) =>
            PlatformError.systemError({ module: "Stdio", method, _tag: "Unknown", cause }),
          endOnDone: false,
        });
        const task = Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                expect(yield* hasClosedStdioPipe).toBe(true);
                events.push("rollback");
                yield* Deferred.succeed(cleanupStarted, undefined);
                yield* Deferred.await(releaseCleanup);
                events.push("released");
              }),
            );
            yield* Stream.make("payload").pipe(Stream.run(sink));
            events.push("write returned");
            return yield* Effect.never;
          }),
        ).pipe(
          Effect.provide(
            Layer.effectDiscard(
              Effect.addFinalizer(() =>
                Effect.sync(() => {
                  events.push("layer released");
                }),
              ),
            ),
          ),
        );
        const fiber = yield* withStdioPipeHandling(task, streams).pipe(Effect.forkScoped);
        yield* Deferred.await(cleanupStarted);
        expect(events).toEqual(["write returned", "rollback"]);
        expect(stream.listenerCount("error")).toBe(1);
        stream.emit("error", error);
        other.emit("error", error);
        yield* Deferred.succeed(releaseCleanup, undefined);
        const exit = yield* Fiber.await(fiber);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(isClosedStdioPipe(exit.cause)).toBe(true);
        expect(events).toEqual(["write returned", "rollback", "released", "layer released"]);
        expect(stream.listenerCount("error")).toBe(0);
        expect(other.listenerCount("error")).toBe(0);
      }),
  );

  it.effect("preserves cleanup defects alongside the typed EPIPE", () =>
    Effect.gen(function* () {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const defect = new Error("rollback failed");
      const exit = yield* withStdioPipeHandling(
        Effect.sync(() =>
          stdout.emit("error", Object.assign(new Error("pipe"), { code: "EPIPE" })),
        ).pipe(Effect.andThen(Effect.never), Effect.ensuring(Effect.die(defect))),
        { stdout, stderr },
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(isClosedStdioPipe(exit.cause)).toBe(true);
        expect(
          exit.cause.reasons.some(
            (reason) => Cause.isDieReason(reason) && reason.defect === defect,
          ),
        ).toBe(true);
      }
    }),
  );

  it.effect("releases the task and listeners when its parent is interrupted", () =>
    Effect.gen(function* () {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const ready = yield* Deferred.make<void>();
      let released = false;
      const task = Deferred.succeed(ready, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Effect.sync(() => {
            released = true;
          }),
        ),
      );
      const fiber = yield* withStdioPipeHandling(task, { stdout, stderr }).pipe(Effect.forkScoped);
      yield* Deferred.await(ready);
      yield* Fiber.interrupt(fiber);
      expect(released).toBe(true);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(stdout.listenerCount("error")).toBe(0);
      expect(stderr.listenerCount("error")).toBe(0);
    }),
  );

  it.effect("removes only owned listeners and isolates consecutive executions", () =>
    Effect.gen(function* () {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const errors: unknown[] = [];
      const listener = (error: unknown) => errors.push(error);
      stdout.on("error", listener);
      const error = Object.assign(new Error("disk full"), { code: "ENOSPC" });
      yield* withStdioPipeHandling(
        Effect.sync(() => stdout.emit("error", error)),
        { stdout, stderr },
      );
      expect(errors).toEqual([error]);
      expect(stdout.listeners("error")).toEqual([listener]);
      expect(stderr.listenerCount("error")).toBe(0);
      const pipeExit = yield* withStdioPipeHandling(
        Effect.sync(() =>
          stderr.emit("error", Object.assign(new Error("pipe"), { code: "EPIPE" })),
        ),
        { stdout, stderr },
      ).pipe(Effect.exit);
      expect(Exit.isFailure(pipeExit) && isClosedStdioPipe(pipeExit.cause)).toBe(true);
      expect(yield* withStdioPipeHandling(hasClosedStdioPipe, { stdout, stderr })).toBe(false);
      stdout.off("error", listener);
      const exit = yield* withStdioPipeHandling(
        Effect.sync(() => stdout.emit("error", error)),
        { stdout, stderr },
      ).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(error);
    }),
  );
});
