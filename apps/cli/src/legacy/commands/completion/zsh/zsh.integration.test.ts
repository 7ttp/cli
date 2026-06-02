import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import { legacyCompletionZshScript } from "../completion.scripts.ts";
import { legacyCompletionZsh } from "./zsh.handler.ts";

describe("legacy completion zsh", () => {
  it.live("prints the native zsh completion script", () => {
    const out = mockOutput({ format: "text" });
    return Effect.gen(function* () {
      yield* legacyCompletionZsh({});
      expect(out.stdoutText).toBe(legacyCompletionZshScript);
      expect(out.stderrText).toBe("");
    }).pipe(Effect.provide(out.layer));
  });
});
