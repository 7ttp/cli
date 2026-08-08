import { describe, expect, it } from "@effect/vitest";
import { Data, Effect } from "effect";

import type { LegacyDbSession } from "../../../shared/legacy-db-connection.service.ts";
import { legacyDropUserSchemas } from "./legacy-drop-schemas.ts";

class TestError extends Data.TaggedError("TestError")<{ readonly message: string }> {}

function fakeSession(opts: { stepDownRole?: "postgres" } = {}) {
  const execs: Array<string> = [];
  const session: LegacyDbSession = {
    ...(opts.stepDownRole !== undefined ? { stepDownRole: opts.stepDownRole } : {}),
    exec: (sql) => {
      execs.push(sql);
      return Effect.void;
    },
    query: () => Effect.succeed([]),
    extensionExists: () => Effect.succeed(false),
    copyToCsv: () => Effect.succeed(new Uint8Array()),
    queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
  };
  return { session, execs };
}

describe("legacyDropUserSchemas (db reset remote)", () => {
  it.effect("runs the drop transaction without a pin when the session did not step down", () => {
    const { session, execs } = fakeSession();
    return legacyDropUserSchemas(session, (message) => new TestError({ message })).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(execs[0]).toBe("BEGIN");
          expect(execs.some((sql) => sql.startsWith("SET LOCAL ROLE"))).toBe(false);
          expect(execs.at(-1)).toBe("COMMIT");
        }),
      ),
    );
  });

  it.effect("pins the postgres role inside the drop transaction for a stepped-down session", () => {
    const { session, execs } = fakeSession({ stepDownRole: "postgres" });
    return legacyDropUserSchemas(session, (message) => new TestError({ message })).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(execs[0]).toBe("BEGIN");
          expect(execs[1]).toBe("SET LOCAL ROLE postgres");
          expect(execs[2]).toContain("drop policy if exists");
          expect(execs.at(-1)).toBe("COMMIT");
        }),
      ),
    );
  });
});
