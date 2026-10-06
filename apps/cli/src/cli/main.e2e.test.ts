import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  makeTempCliProject,
  makeTempHome,
  runSupabase,
  spawnSupabase,
} from "../../tests/helpers/cli.ts";

describe("CLI feature routing", () => {
  test("reports invalid stack feature configuration during completion", async () => {
    const project = await makeTempCliProject("supabase-main-routing-e2e-");
    const home = makeTempHome();
    try {
      const result = await runSupabase(["__complete", "start", "--"], {
        cwd: project.dir,
        home: home.dir,
        env: {
          SUPABASE_EXPERIMENTAL_STACK: "yes",
          SUPABASE_WORKDIR: undefined,
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("SUPABASE_EXPERIMENTAL_STACK must be 0 or 1");
    } finally {
      await project.cleanup();
      home[Symbol.dispose]();
    }
  });
});

describe("CLI output to a closed pipe", () => {
  const projectsList = async (
    args: string[],
    options: { readonly holdRequests?: boolean; readonly closedStdoutPipe?: boolean } = {},
  ) => {
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        if (options.holdRequests) await released;
        return Response.json([]);
      },
    });
    const home = makeTempHome();
    try {
      const profilePath = path.join(home.dir, "closed-pipe-profile.yaml");
      await writeFile(
        profilePath,
        [
          "name: closed-pipe-e2e",
          `api_url: "${server.url.origin}"`,
          `dashboard_url: "${server.url.origin}"`,
          'project_host: "example.invalid"',
          "",
        ].join("\n"),
      );

      return await spawnSupabase(["projects", "list", ...args], {
        cwd: home.dir,
        home: home.dir,
        closedStdoutPipe: options.closedStdoutPipe,
        exitTimeoutMs: 30_000,
        env: {
          SUPABASE_ACCESS_TOKEN: `sbp_${"a".repeat(40)}`,
          SUPABASE_PROFILE: profilePath,
        },
      }).waitForExit();
    } finally {
      release();
      await server.stop(true);
      home[Symbol.dispose]();
    }
  };

  // A held request makes text output print its clack progress line, the listener-less write after
  // which the CLI used to hang; the JSON rows hit the closed pipe in the output sink instead.
  test.skipIf(process.platform === "win32").each<[string[], boolean]>([
    [[], true],
    [["-o", "json"], false],
    [["--output-format", "json"], false],
  ])("exits with 141 when stdout is a closed pipe (args %j)", async (args, holdRequests) => {
    const result = await projectsList(args, { holdRequests, closedStdoutPipe: true });

    expect(result.exitCode, result.stderr).toBe(141);
  });

  test("prints the projects to a drained stdout", async () => {
    const result = await projectsList(["-o", "json"]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });
});
