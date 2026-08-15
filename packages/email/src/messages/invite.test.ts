import { describe, expect, test } from 'vitest';
import { recordingEmailer } from '../testing/recording.ts';
import { renderOrganizationInvite } from './invite.ts';
import { renderText } from './layout.ts';

const emailer = recordingEmailer().service;

describe('renderOrganizationInvite', () => {
  test('subject and recipient carry the invited address, not the inviter', () => {
    const document = renderOrganizationInvite(emailer, {
      kind: 'organization-invite',
      to: 'alice@example.test',
      organizationName: 'Ridgeview Schools',
      role: 'admin',
      invitedByName: 'Dana Cook',
      expiresAt: new Date('2026-09-01T12:00:00Z'),
    });

    expect(document.heading).toBe('Join Ridgeview Schools on Foodservice Insights');
    const text = renderText(document);
    expect(text).toContain('Dana Cook invited you');
    expect(text).toContain('https://example.test/sign-in?email=alice%40example.test');
  });

  test('falls back to "An admin" when the inviter has no display name', () => {
    const document = renderOrganizationInvite(emailer, {
      kind: 'organization-invite',
      to: 'alice@example.test',
      organizationName: 'Ridgeview Schools',
      role: 'member',
      invitedByName: null,
      expiresAt: new Date('2026-09-01T12:00:00Z'),
    });

    expect(renderText(document)).toContain('An admin invited you');
  });
});
