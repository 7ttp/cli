import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { legacyCompletionPowershellScript } from "../completion.scripts.ts";
import { legacyCompletionPowershell } from "./powershell.handler.ts";

describe("legacy completion powershell", () => {
  it.live("prints the native powershell completion script", () => {
    const out = mockOutput({ format: "text" });
    return Effect.gen(function* () {
      yield* legacyCompletionPowershell({});
      expect(out.stdoutText).toBe(legacyCompletionPowershellScript);
      expect(out.stderrText).toBe("");
    }).pipe(Effect.provide(out.layer));
  });
});
