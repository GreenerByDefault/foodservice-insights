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
