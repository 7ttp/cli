#!/usr/bin/env bun
import { runCli } from "../../shared/cli/run.ts";
import { normalizeLegacyArgs } from "./normalize-args.ts";
import { legacyRoot } from "./root.ts";

process.argv.splice(2, process.argv.length - 2, ...normalizeLegacyArgs(process.argv.slice(2)));

await runCli(legacyRoot);
