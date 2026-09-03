/** The state of an async action — a form submission, an API call — that can fail with an
 * error message. */
export type ActionState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success' }
  | { status: 'error'; message: string };
