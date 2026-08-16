import { describe, expect, test } from 'vitest';
import { recordingEmailer } from '../testing/recording.ts';
import { renderOrganizationInvite } from './invite.ts';

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
    expect(document.blocks).toEqual([
      {
        block: 'paragraph',
        text: 'Dana Cook invited you to join Ridgeview Schools. Sign in with this email address to accept.',
      },
      {
        block: 'action',
        label: 'Accept the invitation',
        url: 'https://example.test/sign-in?email=alice%40example.test',
      },
      {
        block: 'facts',
        facts: [
          ['Organization', 'Ridgeview Schools'],
          ['Role', 'Admin'],
          ['Expires', 'September 1, 2026'],
        ],
      },
    ]);
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

    expect(document.blocks[0]).toEqual({
      block: 'paragraph',
      text: 'An admin invited you to join Ridgeview Schools. Sign in with this email address to accept.',
    });
    expect(document.blocks[2]).toEqual({
      block: 'facts',
      facts: [
        ['Organization', 'Ridgeview Schools'],
        ['Role', 'Member'],
        ['Expires', 'September 1, 2026'],
      ],
    });
  });
});
