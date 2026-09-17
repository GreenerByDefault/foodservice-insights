/** Shared by the invite form and its clients. */

export const FIELD = {
  // Not `email`: iOS Safari keys its QuickType contact-autofill suggestion off the field's
  // `name`/`id`, largely independent of `autocomplete="off"` — this is someone else's address,
  // not the viewer's own, so it must not read as a login/profile email field to that heuristic.
  email: 'invitee-email',
  role: 'role',
} as const;
