import { Data } from "effect";

export class ConflictingFunctionDeployFlagsError extends Data.TaggedError(
  "ConflictingFunctionDeployFlagsError",
)<{
  readonly message: string;
}> {}

export class InvalidFunctionDeploySlugError extends Data.TaggedError(
  "InvalidFunctionDeploySlugError",
)<{
  readonly message: string;
}> {}

export class NoFunctionsToDeployError extends Data.TaggedError("NoFunctionsToDeployError")<{
  readonly message: string;
}> {}

export class FunctionDeployCancelledError extends Data.TaggedError("FunctionDeployCancelledError")<{
  readonly message: string;
}> {}

/**
 * A named filesystem/docker step of the deploy flow failed. Carries the
 * underlying cause in `message` so a failure never surfaces as the generic
 * `Effect.tryPromise` UnknownError (#6104).
 */
export class FunctionDeployStepError extends Data.TaggedError("FunctionDeployStepError")<{
  readonly message: string;
}> {}
