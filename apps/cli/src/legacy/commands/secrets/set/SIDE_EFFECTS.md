# `supabase secrets set`

## Files Read

| Path                                      | Format                    | When                                                                                                                                                                     |
| ----------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/proc/sys/kernel/osrelease` (Linux)      | plain text                | once on layer init — disables keyring on WSL (`WSL` / `Microsoft` substring match)                                                                                       |
| keyring `"Supabase CLI"` / `<profile>`    | OS keychain               | when `SUPABASE_ACCESS_TOKEN` unset and keyring available; account = `LegacyCliConfig.profile`                                                                            |
| keyring `"Supabase CLI"` / `access-token` | OS keychain               | legacy-key fallback when the profile-keyed lookup misses                                                                                                                 |
| `~/.supabase/access-token`                | plain text (token string) | last-resort fallback after env + keyring miss                                                                                                                            |
| `<workdir>/supabase/.temp/project-ref`    | plain text                | when `--project-ref` and `SUPABASE_PROJECT_ID` are both unset                                                                                                            |
| `<workdir>/supabase/config.toml`          | raw text (never parsed)   | best-effort regex peek for an `[edge_runtime.secrets]` section header, purely to power the breadcrumb messaging below; any unreadable or absent file is silently ignored |
| `<env-file>` (absolute or CWD-relative)   | dotenv                    | when `--env-file` flag is provided                                                                                                                                       |

## Files Written

| Path                                             | Format | When                                                                     |
| ------------------------------------------------ | ------ | ------------------------------------------------------------------------ |
| `~/.supabase/<workdir-hash>/linked-project.json` | JSON   | always (in `Effect.ensuring`) after `--project-ref` resolves — Go parity |
| `~/.supabase/telemetry.json`                     | JSON   | always (in `Effect.ensuring`) at end of command — Go parity              |

## API Routes

| Method | Path                         | Auth         | Request body                           | Response (used fields)   |
| ------ | ---------------------------- | ------------ | -------------------------------------- | ------------------------ |
| `POST` | `/v1/projects/{ref}/secrets` | Bearer token | `[{name: string, value: string}, ...]` | none (201 expected)      |
| `GET`  | `/v1/projects`               | Bearer token | none                                   | TTY-prompt fallback only |

## Environment Variables

| Variable                | Purpose                                                                                                                                                                                                                                                                                              | Required?                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup)                                                                                                                                                                                                                                                 | no (falls back to keyring → `~/.supabase/access-token`)                    |
| `SUPABASE_PROFILE`      | selects API base URL: `supabase` → `api.supabase.com`, `supabase-staging` → `api.supabase.green`, `supabase-local` → `http://localhost:8080`. May alternatively be a filesystem path to a YAML profile with at least `api_url:` and optional `name:` (Go parity — used by the cli-e2e test harness). | no (defaults to `supabase`)                                                |
| `SUPABASE_PROJECT_ID`   | project ref fallback when `--project-ref` is unset                                                                                                                                                                                                                                                   | no (also reads `<workdir>/supabase/.temp/project-ref` then prompts on TTY) |
| `SUPABASE_WORKDIR`      | base directory for the `.temp/project-ref` lookup                                                                                                                                                                                                                                                    | no (walks up from CWD looking for `supabase/config.toml`)                  |

## Exit Codes

| Code | Condition                                                                                    |
| ---- | -------------------------------------------------------------------------------------------- |
| `0`  | success — secrets set on the linked project                                                  |
| `1`  | `LegacyPlatformAuthRequiredError` — no token in env/keyring/file                             |
| `1`  | `LegacyInvalidAccessTokenError` — token violates `^sbp_(oauth_)?[a-f0-9]{40}$`               |
| `1`  | `LegacyProjectNotLinkedError` — `--project-ref` unset, env/file empty, and stdin not a TTY   |
| `1`  | `LegacyInvalidProjectRefError` — resolved ref violates `^[a-z]{20}$`                         |
| `1`  | `LegacySecretsNoArgumentsError` — no positional `NAME=VALUE` pairs and no `--env-file` given |
| `1`  | `LegacyInvalidSecretPairError` — positional argument missing `=`                             |
| `1`  | `LegacySecretsEnvFileOpenError` — `--env-file` cannot be opened                              |
| `1`  | `LegacySecretsEnvFileParseError` — `--env-file` cannot be parsed                             |
| `1`  | `LegacySecretsSetUnexpectedStatusError` — non-2xx response from POST                         |
| `1`  | `LegacySecretsSetNetworkError` — transport-level network failure                             |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups                                                         |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` (`--project-ref` / `--env-file` → `<redacted>`) |

Matches `apps/cli-go/internal/secrets/set/`. Go does not fire any custom telemetry event for this command.

## Output

### `--output pretty` (Go default) / `--output-format text`

Stdout: `Finished supabase secrets set.\n`. Stderr: one `Env name cannot start with SUPABASE_, skipping: <name>` line per filtered entry.

Go's `--output {json,yaml,toml,env}` flags all collapse to the same text-mode `Finished` message (Go `set.go:42` ignores `--output`).

### `--output-format json`

Single JSON object emitted via `Output.success` with `{project_ref, count}` as the `data` field.

### `--output-format stream-json`

One `result` NDJSON event on success containing `{project_ref, count}`.

## Notes

- Source order for merging entries: `--env-file` → CLI args (overrides env-file for the same name). Explicit inputs only.
- `SUPABASE_`-prefixed entries are skipped post-merge with a stderr warning.
- `[edge_runtime.secrets]` from `config.toml` is deliberately excluded (supabase/supabase#45242): Go's `set.ListSecrets` mixes config secrets into the same bulk-create payload, so `secrets set BAR=bar` also uploaded every config secret and produced duplicate remote entries with differing digests. Remote uploads are explicit; local edge-runtime config secrets are consumed by `functions serve` independently. When the section header is present in `config.toml`, the command prints a stderr note (or extends the no-arguments error) pointing at explicit args / `--env-file`.
- Sends `User-Agent: SupabaseCLI/<version>` and Bearer auth. No `X-Supabase-Command` headers — Go parity.
