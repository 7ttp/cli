import { Effect } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { legacyCompletionFishScript } from "../completion.scripts.ts";
import type { LegacyCompletionFishFlags } from "./fish.command.ts";

export const legacyCompletionFish = Effect.fn("legacy.completion.fish")(function* (
  _flags: LegacyCompletionFishFlags,
) {
  const output = yield* Output;
  yield* output.raw(legacyCompletionFishScript);
});
