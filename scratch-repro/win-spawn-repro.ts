/**
 * Windows spawn-hang repro harness for supabase/cli#6110.
 *
 * Each invocation runs ONE case (argv[2]) and prints progress markers so an
 * external `timeout` wrapper can classify OK vs HANG and show where it parked.
 * Uses the exact effect/platform-bun versions and spawn patterns the CLI uses.
 */
import { BunServices } from "@effect/platform-bun";
import { Effect, Stream } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner";

const CASE = process.argv[2] ?? "";
const mark = (m: string) => console.log(`[${CASE}] ${m}`);

type Spawner = ChildProcessSpawner["Service"];

/** Mirror of local-db-running.ts: drain stderr to completion, THEN await exit. */
const sequentialPattern = (spawner: Spawner, cmd: string, args: string[]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(cmd, args, {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
          extendEnv: true,
        }),
      );
      mark("spawned");
      const stderrChunks: Array<Uint8Array> = [];
      yield* Stream.runForEach(child.stderr, (chunk) =>
        Effect.sync(() => {
          stderrChunks.push(chunk);
        }),
      );
      mark("stderr-drained");
      const exit = yield* child.exitCode;
      mark(`exit=${exit} stderr=${new TextDecoder().decode(Buffer.concat(stderrChunks)).trim()}`);
    }),
  );

/** Mirror of legacy-container-cli.ts helpers: exit + stderr awaited concurrently. */
const concurrentPattern = (spawner: Spawner, cmd: string, args: string[]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(cmd, args, {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
          extendEnv: true,
        }),
      );
      mark("spawned");
      const [exit, stderr] = yield* Effect.all(
        [
          child.exitCode.pipe(Effect.map(Number)),
          Stream.runFold(child.stderr, () => "", (acc, c) => acc + new TextDecoder().decode(c)),
        ],
        { concurrency: "unbounded" },
      );
      mark(`exit=${exit} stderr=${stderr.trim()}`);
    }),
  );

/** Candidate fix: subscribe stderr eagerly, await exit, then bounded stderr grace. */
const fixPattern = (spawner: Spawner, cmd: string, args: string[]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(cmd, args, {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "pipe",
          extendEnv: true,
        }),
      );
      mark("spawned");
      const stderrChunks: Array<Uint8Array> = [];
      const drainFiber = yield* Stream.runForEach(child.stderr, (chunk) =>
        Effect.sync(() => {
          stderrChunks.push(chunk);
        }),
      ).pipe(Effect.forkChild({ startImmediately: true }));
      const exit = yield* child.exitCode;
      mark(`exit=${exit}`);
      yield* drainFiber.await.pipe(Effect.timeoutOption("2 seconds"));
      mark(`stderr=${new TextDecoder().decode(Buffer.concat(stderrChunks)).trim()}`);
    }),
  );

/** Bare spawn + exit only — tests the "spawn" event delivery and the win32 non-zero-exit taskkill finalizer. */
const bareExit = (spawner: Spawner, cmd: string, args: string[]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(cmd, args, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }),
      );
      mark("spawned");
      const exit = yield* child.exitCode;
      mark(`exit=${exit}`);
    }),
  );

const CMD = "C:\\Windows\\System32\\cmd.exe";
// A grandchild that inherits the stderr handle and outlives the child by ~25s.
const GRANDCHILD = 'start /b ping -n 25 127.0.0.1 > nul';

const program = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner;
  mark("start");
  switch (CASE) {
    case "exit0-bare":
      return yield* bareExit(spawner, CMD, ["/d", "/c", "exit 0"]);
    case "exit1-bare":
      return yield* bareExit(spawner, CMD, ["/d", "/c", "exit 1"]);
    case "exit1-stderr-seq":
      return yield* sequentialPattern(spawner, CMD, ["/d", "/c", "echo No such container 1>&2 & exit 1"]);
    case "exit1-grandchild-seq":
      return yield* sequentialPattern(spawner, CMD, ["/d", "/c", `${GRANDCHILD} & echo No such container 1>&2 & exit 1`]);
    case "exit1-grandchild-conc":
      return yield* concurrentPattern(spawner, CMD, ["/d", "/c", `${GRANDCHILD} & echo No such container 1>&2 & exit 1`]);
    case "exit1-grandchild-fix":
      return yield* fixPattern(spawner, CMD, ["/d", "/c", `${GRANDCHILD} & echo No such container 1>&2 & exit 1`]);
    case "docker-inspect-seq":
      return yield* sequentialPattern(spawner, "docker", ["container", "inspect", "supabase_db_repro6110"]);
    case "docker-inspect-fix":
      return yield* fixPattern(spawner, "docker", ["container", "inspect", "supabase_db_repro6110"]);
    default:
      mark(`unknown case: ${CASE}`);
      return;
  }
}).pipe(Effect.provide(BunServices.layer));

await Effect.runPromise(program)
  .then(() => {
    mark("DONE");
    process.exit(0);
  })
  .catch((error) => {
    mark(`ERROR: ${String(error)}`);
    process.exit(0);
  });
