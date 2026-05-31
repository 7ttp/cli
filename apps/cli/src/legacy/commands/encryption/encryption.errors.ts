import { Data } from "effect";

export class LegacyEncryptionGetRootKeyNetworkError extends Data.TaggedError(
  "LegacyEncryptionGetRootKeyNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyEncryptionGetRootKeyUnexpectedStatusError extends Data.TaggedError(
  "LegacyEncryptionGetRootKeyUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}

export class LegacyEncryptionUpdateRootKeyNetworkError extends Data.TaggedError(
  "LegacyEncryptionUpdateRootKeyNetworkError",
)<{
  readonly message: string;
}> {}

export class LegacyEncryptionUpdateRootKeyUnexpectedStatusError extends Data.TaggedError(
  "LegacyEncryptionUpdateRootKeyUnexpectedStatusError",
)<{
  readonly status: number;
  readonly body: string;
  readonly message: string;
}> {}
