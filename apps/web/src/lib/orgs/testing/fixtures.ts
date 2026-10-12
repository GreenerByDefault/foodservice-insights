import { jsonResponse } from '#lib/testing/fetch.js';

/** The 409 every member write answers with when it would leave the organization with no admin. */
export function aLastAdminResponse(): Response {
  return jsonResponse({ message: 'Only admin', code: 'last-admin' }, 409);
}
