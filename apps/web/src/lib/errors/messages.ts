/** The copy a user sees when a request fails.
 *
 * Page copy is chosen from the HTTP status alone, never from the error body. Nothing a route hands
 * to `error()` reaches the screen, so no call site can leak an internal detail into the UI, and no
 * message becomes user-facing copy without being written here.
 */

export interface ErrorPresentation {
  /** The page heading, and the document title. */
  title: string;
  body: string;
  /** Whether to print "Error <status>". Worth it only when the copy has not already said it. */
  showStatus: boolean;
}

/** What `handleError` hands back for a failure we did not anticipate. */
export const UNEXPECTED_ERROR_MESSAGE = 'Something went wrong. Please try again.';

/** For a failure in something we depend on, where the caller's own request was fine and retrying
 * it is the answer. An API client reads the `code`; a page reads only the 503 it comes with.
 */
export const SERVICE_UNAVAILABLE_ERROR: App.Error = {
  message: 'The service is temporarily unavailable',
  code: 'service_unavailable',
};

export function describeError(status: number): ErrorPresentation {
  switch (status) {
    case 401:
      return {
        title: 'Sign in to continue',
        body: 'You need to be signed in to see this page.',
        showStatus: false,
      };
    case 403:
      return {
        title: "You don't have access",
        body: "Your account can't see this page. An admin in your organization can change that.",
        showStatus: false,
      };
    case 404:
      return {
        title: 'Page not found',
        body: "That page doesn't exist. It may have moved, or the address may have a typo.",
        showStatus: false,
      };
    case 503:
      return {
        title: 'Temporarily unavailable',
        body: "We can't reach something we need right now. This is usually brief, so wait a moment and try again.",
        showStatus: true,
      };
  }

  if (status >= 500) {
    return {
      title: 'Something went wrong',
      body: 'This was not caused by anything you did. Trying again often works.',
      showStatus: true,
    };
  }

  return {
    title: "That didn't work",
    body: "We couldn't handle that request. Trying again often works.",
    showStatus: true,
  };
}
