/** Reads a CHECK constraint's guarantee back out of a query result, in place of a bare `!` that
 * would silently produce a wrong value if the constraint were ever violated.
 */
export function requireConstraint<T>(value: T | null, constraint: string): T {
  if (value === null) throw new Error(`Expected ${constraint} to hold, but got null`);
  return value;
}
