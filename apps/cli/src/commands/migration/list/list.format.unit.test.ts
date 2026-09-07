import { describe, expect, it } from "vitest";

import { renderGlamourTable } from "../../../output/legacy-glamour-table.ts";
import { legacyMakeMigrationListRows, legacyMigrationListTableCells } from "./list.format.ts";

describe("legacyMakeMigrationListRows", () => {
  it("tabulates short numeric versions in chronological order (Go TestMakeTable)", () => {
    // makeTable(["0","2"], ["0","1"]) — passthrough time for non-timestamp versions.
    expect(legacyMakeMigrationListRows(["0", "2"], ["0", "1"])).toEqual([
      { local: "0", remote: "0", time: "0" },
      { local: "1", remote: "", time: "1" },
      { local: "", remote: "2", time: "2" },
    ]);
  });

  it("tabulates real timestamps with a humanised time column", () => {
    expect(
      legacyMakeMigrationListRows(
        ["20220727064246", "20220727064248"],
        ["20220727064246", "20220727064247"],
      ),
    ).toEqual([
      { local: "20220727064246", remote: "20220727064246", time: "2022-07-27 06:42:46" },
      { local: "20220727064247", remote: "", time: "2022-07-27 06:42:47" },
      { local: "", remote: "20220727064248", time: "2022-07-27 06:42:48" },
    ]);
  });

  it("orders local-only versions numerically, not by text", () => {
    // Local versions arrive in file-name order, where `20260101000000_b.sql`
    // precedes `203_a.sql` ('2' < '3'), and the walk compares integers, so the
    // column has to be ordered by that same integer value.
    expect(legacyMakeMigrationListRows([], ["20260101000000", "203"])).toEqual([
      { local: "203", remote: "", time: "203" },
      { local: "20260101000000", remote: "", time: "2026-01-01 00:00:00" },
    ]);
  });

  it("pairs a short version that a timestamp outranks in text order", () => {
    // `ORDER BY version` returns `20260101000000` before `203` (text order),
    // while the walk compares integers. Unordered, `203` is applied on both
    // sides yet renders as two half-empty rows.
    expect(legacyMakeMigrationListRows(["201", "20260101000000", "203"], ["201", "203"])).toEqual([
      { local: "201", remote: "201", time: "201" },
      { local: "203", remote: "203", time: "203" },
      { local: "", remote: "20260101000000", time: "2026-01-01 00:00:00" },
    ]);
  });

  it("pairs an 8-digit and a 14-digit version that share a prefix (#6036)", () => {
    // Local versions arrive in file-name order, where `20260420010000_b.sql`
    // precedes `20260420_a.sql` ('0' < '_') — the reverse of the `ORDER BY
    // version` order `schema_migrations` is read back in. Unsorted, the walk
    // desynchronises and reports `20260420` as both remote-only and local-only.
    expect(
      legacyMakeMigrationListRows(["20260420", "20260420010000"], ["20260420010000", "20260420"]),
    ).toEqual([
      { local: "20260420", remote: "20260420", time: "20260420" },
      { local: "20260420010000", remote: "20260420010000", time: "2026-04-20 01:00:00" },
    ]);
  });

  it("renders the largest in-range version instead of dropping it", () => {
    expect(legacyMakeMigrationListRows(["9223372036854775807"], [])).toEqual([
      { local: "", remote: "9223372036854775807", time: "9223372036854775807" },
    ]);
    expect(legacyMakeMigrationListRows([], ["9223372036854775807"])).toEqual([
      { local: "9223372036854775807", remote: "", time: "9223372036854775807" },
    ]);
  });

  it("skips non-numeric versions on both sides", () => {
    expect(legacyMakeMigrationListRows(["a", "c"], ["a", "b"])).toEqual([]);
  });

  it("renders local-only and remote-only rows when one side is empty", () => {
    expect(legacyMakeMigrationListRows([], ["20240101000000"])).toEqual([
      { local: "20240101000000", remote: "", time: "2024-01-01 00:00:00" },
    ]);
    expect(legacyMakeMigrationListRows(["20240101000000"], [])).toEqual([
      { local: "", remote: "20240101000000", time: "2024-01-01 00:00:00" },
    ]);
  });
});

describe("legacyMigrationListTableCells", () => {
  it("wraps present cells in backticks and absent cells in a backtick-space-backtick", () => {
    const cells = legacyMigrationListTableCells([
      { local: "20240101000000", remote: "", time: "2024-01-01 00:00:00" },
    ]);
    expect(cells).toEqual([["`20240101000000`", "` `", "`2024-01-01 00:00:00`"]]);
  });

  it("produces a Glamour table whose body matches Go's `migration list` rendering", () => {
    const rows = legacyMakeMigrationListRows(["20220727064248"], ["20220727064247"]);
    const out = renderGlamourTable(
      ["Local", "Remote", "Time (UTC)"],
      legacyMigrationListTableCells(rows),
    );
    // Backtick-wrapped inline code is preserved by AsciiStyle.
    expect(out).toContain("` `");
    expect(out).toContain("`20220727064247`");
    expect(out).toContain("`20220727064248`");
    expect(out).toContain("Local");
    expect(out).toContain("Time (UTC)");
  });
});
