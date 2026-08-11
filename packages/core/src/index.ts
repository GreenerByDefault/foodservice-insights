/** Product name, as shown to users.
 *
 * This is a placeholder value only to set up packages/core.
 */
export const APP_NAME = 'Foodservice Insights';

/**
 * Exhaustiveness check for discriminated unions. Calling this is a type error unless
 * every case has already been handled, which turns a missed case into a compile
 * failure rather than a silent fallthrough at runtime.
 */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}

/** A compile error if the array is missing a member of `T`, not just if it has one `T` lacks. */
export function exhaustiveArray<T extends string>() {
  // Curried so `T` can be given explicitly at the call site while `A` is still inferred from
  // the array literal — a single generic function can't do both at once.
  return <const A extends readonly T[]>(
    array: Exclude<T, A[number]> extends never ? A : `missing: ${Exclude<T, A[number]>}`,
  ): A => array as A;
}
