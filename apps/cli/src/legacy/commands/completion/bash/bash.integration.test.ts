import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { legacyCompletionBashScript } from "../completion.scripts.ts";
import { legacyCompletionBash } from "./bash.handler.ts";

describe("legacy completion bash", () => {
  it.live("prints the native bash completion script", () => {
    const out = mockOutput({ format: "text" });
    return Effect.gen(function* () {
      yield* legacyCompletionBash({});
      expect(out.stdoutText).toBe(legacyCompletionBashScript);
      expect(out.stderrText).toBe("");
    }).pipe(Effect.provide(out.layer));
  });
});
