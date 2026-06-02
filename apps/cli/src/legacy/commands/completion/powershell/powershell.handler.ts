import { Effect } from "effect";
import { Output } from "../../../../shared/output/output.service.ts";
import { legacyCompletionPowershellScript } from "../completion.scripts.ts";
import type { LegacyCompletionPowershellFlags } from "./powershell.command.ts";

export const legacyCompletionPowershell = Effect.fn("legacy.completion.powershell")(function* (
  _flags: LegacyCompletionPowershellFlags,
) {
  const output = yield* Output;
  yield* output.raw(legacyCompletionPowershellScript);
});
