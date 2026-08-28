/**
 * Represents the state of an async action (e.g., form submission, API call).
 *
 * Use this for actions that can fail with an error message.
 */
export type ActionState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success' }
  | { status: 'error'; message: string };

/**
 * Represents the state of a simple async action that doesn't have error handling.
 *
 * Use this for actions where errors are handled through other means (e.g., toasts).
 */
export type BasicActionState = 'idle' | 'loading' | 'success';
