/** Remembers which address this tab was last sent a sign-in code for, so a reload — on mobile, the
 * hop to the mail app can cost one — returns to the code step instead of an empty email field.
 * Asking again would either be refused by GoTrue's per-address rate limit or spend the code the
 * visitor is holding.
 *
 * `sessionStorage`, because a pending code belongs to the tab that asked for it. Merely touching
 * it throws where storage is blocked, so every access is guarded; the flow works without it. */

import * as v from 'valibot';
import { emailAddress } from '#lib/forms/validation.js';

const PENDING_CODE_KEY = 'gbd.sign-in.pending-code';

/** A code's default lifetime, both locally and in the hosted dashboard's "Email OTP Expiration".
 * Only a cap: it stops a day-old tab reopening on a code step. If the real lifetime is shorter, a
 * restored step meets `otp_expired`, whose copy already says to send a new code. */
export const PENDING_CODE_TTL_MS = 60 * 60 * 1000;

const PendingCodeSchema = v.object({ email: emailAddress, sentAt: v.number() });
type PendingCode = v.InferOutput<typeof PendingCodeSchema>;

export function parsePendingCode(raw: string | null, now: number): string | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = v.safeParse(PendingCodeSchema, value);
  if (!parsed.success) return null;
  const age = now - parsed.output.sentAt;
  return age >= 0 && age < PENDING_CODE_TTL_MS ? parsed.output.email : null;
}

export function readPendingCode(): string | null {
  try {
    return parsePendingCode(sessionStorage.getItem(PENDING_CODE_KEY), Date.now());
  } catch {
    return null;
  }
}

export function rememberPendingCode(email: string): void {
  const value: PendingCode = { email, sentAt: Date.now() };
  try {
    sessionStorage.setItem(PENDING_CODE_KEY, JSON.stringify(value));
  } catch {}
}

export function forgetPendingCode(): void {
  try {
    sessionStorage.removeItem(PENDING_CODE_KEY);
  } catch {}
}
