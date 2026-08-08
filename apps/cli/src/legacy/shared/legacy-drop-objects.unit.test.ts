import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, Exit } from "effect";

import type { LegacyDbSession } from "./legacy-db-connection.service.ts";
import { legacyDropUserSchemas } from "./legacy-drop-objects.ts";

class FakeExecError extends Data.TaggedError("LegacyDbExecError")<{
  readonly message: string;
}> {}

function fakeSession(opts: { failOn?: string; stepDownRole?: "postgres" } = {}) {
  const execs: Array<string> = [];
  const session: LegacyDbSession = {
    ...(opts.stepDownRole !== undefined ? { stepDownRole: opts.stepDownRole } : {}),
    exec: (sql) => {
      execs.push(sql);
      return opts.failOn !== undefined && sql.includes(opts.failOn)
        ? Effect.fail(new FakeExecError({ message: "exec failed" }))
        : Effect.void;
    },
    query: () => Effect.succeed([]),
    extensionExists: () => Effect.succeed(false),
    copyToCsv: () => Effect.succeed(new Uint8Array()),
    queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
  };
  return { session, execs };
}

describe("legacyDropUserSchemas (shared drop-objects)", () => {
  it.effect("runs the drop block as one bare statement without a step-down (Go parity)", () => {
    const { session, execs } = fakeSession();
    return legacyDropUserSchemas(session).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(execs).toHaveLength(1);
          expect(execs[0]).toContain("drop policy if exists");
        }),
      ),
    );
  });

  it.effect("wraps the drop block in a pinned transaction for a stepped-down session", () => {
    const { session, execs } = fakeSession({ stepDownRole: "postgres" });
    return legacyDropUserSchemas(session).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(execs[0]).toBe("BEGIN");
          expect(execs[1]).toBe("SET LOCAL ROLE postgres");
          expect(execs[2]).toContain("drop policy if exists");
          expect(execs[3]).toBe("COMMIT");
        }),
      ),
    );
  });

  it.effect("rolls back the pinned transaction when the drop block fails", () => {
    const { session, execs } = fakeSession({
      stepDownRole: "postgres",
      failOn: "drop policy",
    });
    return legacyDropUserSchemas(session).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          expect(execs).toContain("ROLLBACK");
          expect(execs).not.toContain("COMMIT");
        }),
      ),
    );
  });
});
