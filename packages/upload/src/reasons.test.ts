import type { RejectedUploadReason } from '@gbd/db';
import { expect, test } from 'vitest';
import { REJECTION_MESSAGES, REJECTION_REASONS, reject } from './reasons.ts';

/** The real check, and it is the annotation rather than anything the test body does: if a value
 * here ever stops being a `rejected_upload_reason`, `pnpm check` fails and a rejection that the
 * database could not store never reaches a route.
 */
const STORABLE: readonly RejectedUploadReason[] = REJECTION_REASONS;

test('every reason is storable in rejected_upload.rejection_reason', () => {
  expect(STORABLE).toEqual(REJECTION_REASONS);
});

test('every reason has a message', () => {
  expect(Object.keys(REJECTION_MESSAGES).sort()).toEqual([...REJECTION_REASONS].sort());
});

test('reject omits detail rather than setting it undefined', () => {
  // `rejected_upload.rejection_detail` is nullable, and a key holding `undefined` serialises
  // differently from an absent one.
  expect(reject('empty')).not.toHaveProperty('detail');
});

test('reject carries the detail it is given', () => {
  expect(reject('too_large', '99 bytes')).toMatchObject({
    reason: 'too_large',
    detail: '99 bytes',
  });
});
