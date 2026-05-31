# `supabase encryption update-root-key`

## Files Read

| Path                       | Format                    | When                                                       |
| -------------------------- | ------------------------- | ---------------------------------------------------------- |
| `~/.supabase/access-token` | plain text (token string) | when `SUPABASE_ACCESS_TOKEN` unset and keyring unavailable |
| stdin                      | tty / piped bytes         | always - reads the replacement root key                    |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| none | n/a    | never |

## API Routes

| Method | Path                          | Auth         | Request body          | Response (used fields) |
| ------ | ----------------------------- | ------------ | --------------------- | ---------------------- |
| `PUT`  | `/v1/projects/{ref}/pgsodium` | Bearer token | `{"root_key":"..."}` | `{root_key}`           |

## Environment Variables

| Variable                | Purpose                                              | Required?                                               |
| ----------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | auth token (bypasses credential file/keyring lookup) | no (falls back to keyring -> `~/.supabase/access-token`) |
| `SUPABASE_API_URL`      | override Management API base URL                     | no (defaults to `https://api.supabase.com`)             |

## Exit Codes

| Code | Condition                                           |
| ---- | --------------------------------------------------- |
| `0`  | success - root key updated                          |
| `1`  | authentication error - no valid token found         |
| `1`  | API error - non-2xx response from encryption endpoint |
| `1`  | network / connection failure                        |

## Output

### `--output-format text` (default)

Writes `Enter a new root key: ` to stderr, emits a single newline to stdout after input is read, then writes `Finished supabase root-key update.` to stderr on success.

## Notes

- Requires `--project-ref` or a linked project (`.supabase/config.json`).
- Reads masked input from TTY stdin and raw bytes from piped stdin, then trims surrounding whitespace before the `PUT`.
- Legacy `--output` values are ignored by this command, matching Go.
- `--output-format json` and `--output-format stream-json` are TS-only structured output modes.
