import { describe, expect, it } from "vitest";
import { normalizeLegacyArgs } from "./normalize-args.ts";

describe("normalizeLegacyArgs", () => {
  it("moves parent --project-ref after the first subcommand", () => {
    expect(normalizeLegacyArgs(["config", "--project-ref", "foo", "push"])).toEqual([
      "config",
      "push",
      "--project-ref",
      "foo",
    ]);
  });

  it("preserves root globals before the subcommand", () => {
    expect(normalizeLegacyArgs(["config", "--debug", "--project-ref", "foo", "push"])).toEqual([
      "config",
      "--debug",
      "push",
      "--project-ref",
      "foo",
    ]);
  });

  it("preserves root globals with values before the subcommand", () => {
    expect(
      normalizeLegacyArgs(["config", "--profile", "dev", "--project-ref", "foo", "push"]),
    ).toEqual(["config", "--profile", "dev", "push", "--project-ref", "foo"]);
  });

  it("moves inline parent --project-ref values after the first subcommand", () => {
    expect(normalizeLegacyArgs(["secrets", "--project-ref=foo", "list"])).toEqual([
      "secrets",
      "list",
      "--project-ref=foo",
    ]);
  });

  it("leaves already-correct leaf flag placement unchanged", () => {
    expect(normalizeLegacyArgs(["secrets", "list", "--project-ref", "foo"])).toEqual([
      "secrets",
      "list",
      "--project-ref",
      "foo",
    ]);
  });

  it("leaves unrelated commands unchanged", () => {
    expect(normalizeLegacyArgs(["functions", "--project-ref", "foo", "list"])).toEqual([
      "functions",
      "--project-ref",
      "foo",
      "list",
    ]);
  });
});
