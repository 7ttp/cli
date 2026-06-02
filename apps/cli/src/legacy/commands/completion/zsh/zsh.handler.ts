import { Effect } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { legacyCompletionZshScript } from "../completion.scripts.ts";
import type { LegacyCompletionZshFlags } from "./zsh.command.ts";

export const legacyCompletionZsh = Effect.fn("legacy.completion.zsh")(function* (
  _flags: LegacyCompletionZshFlags,
) {
  const output = yield* Output;
  yield* output.raw(legacyCompletionZshScript);
});
