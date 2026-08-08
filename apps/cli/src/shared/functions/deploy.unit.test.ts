import { describe, expect, it } from "vitest";

import { isUserDefinedDockerNetwork } from "./deploy.ts";

describe("isUserDefinedDockerNetwork", () => {
  it("treats a named network as user-defined", () => {
    expect(isUserDefinedDockerNetwork("supabase_network_demo")).toBe(true);
  });

  it.each(["", "default", "bridge", "host", "none"])(
    "does not treat the built-in network mode %j as user-defined",
    (networkMode) => {
      expect(isUserDefinedDockerNetwork(networkMode)).toBe(false);
    },
  );

  // Go's `IsContainer` splits on the first `:` and compares the head to
  // `container`, so every one of these is container mode — a network namespace
  // to join, never a network to create.
  it.each(["container:some-id", "container:", "container:a:b"])(
    "does not treat the container network mode %j as user-defined",
    (networkMode) => {
      expect(isUserDefinedDockerNetwork(networkMode)).toBe(false);
    },
  );

  it.each(["container", "containers:some-id", "my-container:1"])(
    "still treats %j as user-defined — only an exact `container:` head is container mode",
    (networkMode) => {
      expect(isUserDefinedDockerNetwork(networkMode)).toBe(true);
    },
  );
});
