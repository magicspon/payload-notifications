/** Returns `[error, undefined]` on rejection or `[undefined, result]` on resolution. */
export async function attemptAsync<T>(
  fn: () => Promise<T>,
): Promise<[Error, undefined] | [undefined, T]> {
  try {
    return [undefined, await fn()]
  } catch (err) {
    return [err instanceof Error ? err : new Error(String(err)), undefined]
  }
}
