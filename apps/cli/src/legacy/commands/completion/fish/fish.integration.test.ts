import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { legacyCompletionFishScript } from "../completion.scripts.ts";
import { legacyCompletionFish } from "./fish.handler.ts";

describe("legacy completion fish", () => {
  it.live("prints the native fish completion script", () => {
    const out = mockOutput({ format: "text" });
    return Effect.gen(function* () {
      yield* legacyCompletionFish({});
      expect(out.stdoutText).toBe(legacyCompletionFishScript);
      expect(out.stderrText).toBe("");
    }).pipe(Effect.provide(out.layer));
  });
});
