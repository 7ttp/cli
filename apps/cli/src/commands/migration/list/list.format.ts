import {
  legacyFormatTimestampVersion,
  legacyOrderMigrationVersions,
} from "../../../command-internal/legacy-migration-timestamp.format.ts";

/** A merged local/remote migration row. `local`/`remote` are empty when absent. */
export interface LegacyMigrationListRow {
  readonly local: string;
  readonly remote: string;
  readonly time: string;
}

/**
 * Two-pointer merge of remote + local migration versions into chronological
 * rows, minus the markdown framing: non-numeric versions are skipped, and the time
 * column uses `FormatTimestampVersion`.
 */
export function legacyMakeMigrationListRows(
  remote: ReadonlyArray<string>,
  local: ReadonlyArray<string>,
): ReadonlyArray<LegacyMigrationListRow> {
  // Neither side arrives in the integer order this walk compares them in —
  // `ORDER BY version` is a `text` sort and `legacyLoadLocalVersions` yields
  // file-name order — so an unordered walk splits a version applied on both
  // sides into duplicate half-empty rows (supabase/cli#6036).
  const sortedRemote = legacyOrderMigrationVersions(remote);
  const sortedLocal = legacyOrderMigrationVersions(local);
  const rows: Array<LegacyMigrationListRow> = [];
  let i = 0;
  let j = 0;
  while (i < sortedRemote.length || j < sortedLocal.length) {
    const remoteEntry = sortedRemote[i];
    const localEntry = sortedLocal[j];
    if (
      localEntry !== undefined &&
      (remoteEntry === undefined || localEntry.value < remoteEntry.value)
    ) {
      const version = localEntry.version;
      rows.push({ local: version, remote: "", time: legacyFormatTimestampVersion(version) });
      j++;
    } else if (
      remoteEntry !== undefined &&
      (localEntry === undefined || remoteEntry.value < localEntry.value)
    ) {
      const version = remoteEntry.version;
      rows.push({ local: "", remote: version, time: legacyFormatTimestampVersion(version) });
      i++;
    } else {
      // Equal values, so both sides are present: the loop runs only while one
      // of them is, and the branches above take every exhausted-side case.
      if (localEntry !== undefined && remoteEntry !== undefined) {
        rows.push({
          local: localEntry.version,
          remote: remoteEntry.version,
          time: legacyFormatTimestampVersion(remoteEntry.version),
        });
      }
      i++;
      j++;
    }
  }
  return rows;
}

/**
 * Renders the merged rows as backtick-wrapped Glamour markdown cells
 * (`|`<v>`|` `|`<time>`|`): present cells are inline code spans, absent
 * cells are a single space inside backticks. AsciiStyle preserves the backticks
 * (`code.block_prefix`/`block_suffix` = "`"), so the rendered table includes them.
 */
export function legacyMigrationListTableCells(
  rows: ReadonlyArray<LegacyMigrationListRow>,
): ReadonlyArray<readonly [string, string, string]> {
  const cell = (value: string): string => (value.length > 0 ? `\`${value}\`` : "` `");
  return rows.map((row) => [cell(row.local), cell(row.remote), `\`${row.time}\``] as const);
}
