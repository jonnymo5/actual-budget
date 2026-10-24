const expectedErrors = new WeakSet<Error>();

/**
 * An error the caller can act on (bad input, unknown id, missing `confirm`).
 * Its message goes straight to the model, so make it say what to do next.
 */
export function toolError(message: string): Error {
  const error = new Error(message);
  expectedErrors.add(error);
  return error;
}

/** True for errors made by `toolError`; anything else is an unexpected failure. */
export function isToolError(error: unknown): boolean {
  return error instanceof Error && expectedErrors.has(error);
}
