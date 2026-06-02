# `supabase completion`

## Files Read

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable | Purpose | Required? |
| -------- | ------- | --------- |
| —        | —       | —         |

## Exit Codes

| Code | Condition                                                         |
| ---- | ----------------------------------------------------------------- |
| `0`  | success, completion script for the chosen shell printed to stdout |
| `1`  | invocation error (missing or unknown shell subcommand)            |

## Output

`supabase completion <shell>` prints a shell-specific autocompletion script to stdout.
The subcommand tree mirrors the Go CLI exactly: `bash`, `fish`, `powershell`, `zsh`.

In the legacy shell every subcommand emits a native static script whose bytes are copied
from the Go CLI output. That matters because users may already have those exact bytes
cached in shell startup files or package-managed completion directories.

Those scripts still call back to `supabase __complete <args>` on every tab press. That
runtime path stays on the bundled Go binary via
`apps/cli/src/legacy/cli/complete-passthrough.ts`, which forwards the raw completion
argv verbatim so Cobra remains the authority on dynamic completion behavior.

## Notes

- The generated scripts intentionally keep Cobra's runtime callback shape instead of
  switching to Effect CLI's `--completions` generator. That preserves the existing
  installed shell artifacts without reimplementing Cobra's dynamic completion
  protocol in TS.
- Effect CLI's `--completions` global flag remains exposed at the root for `next/`
  users; it does not satisfy the legacy parity contract and is not what this
  subcommand routes through.
- The Go CLI exits non-zero when called without a shell subcommand (e.g.
  `supabase completion`). Effect CLI surfaces the same condition through its usual
  "missing subcommand" help-with-exit-1 behavior.
