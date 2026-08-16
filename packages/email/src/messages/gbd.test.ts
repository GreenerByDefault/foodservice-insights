import { describe, expect, test } from 'vitest';
import {
  renderGbdOrganizationCreated,
  renderGbdOrganizationDeleted,
  renderGbdUserDeleted,
} from './gbd.ts';

describe('renderGbdOrganizationCreated', () => {
  test('names the organization and who created it', () => {
    const document = renderGbdOrganizationCreated({
      kind: 'gbd-organization-created',
      organizationName: 'Ridgeview Schools',
      actorEmail: 'dana@ridgeview.test',
    });

    expect(document.heading).toBe('New organization: Ridgeview Schools');
    expect(document.blocks).toEqual([
      {
        block: 'facts',
        facts: [
          ['Organization', 'Ridgeview Schools'],
          ['Created by', 'dana@ridgeview.test'],
        ],
      },
    ]);
  });
});

describe('renderGbdOrganizationDeleted', () => {
  test('names the organization, who deleted it, and that accounts survive', () => {
    const document = renderGbdOrganizationDeleted({
      kind: 'gbd-organization-deleted',
      organizationName: 'Ridgeview Schools',
      actorEmail: 'dana@ridgeview.test',
    });

    expect(document.heading).toBe('Organization deleted: Ridgeview Schools');
    expect(document.blocks).toEqual([
      {
        block: 'paragraph',
        text: 'Its reports and input files were deleted with it. No user accounts were.',
      },
      {
        block: 'facts',
        facts: [
          ['Organization', 'Ridgeview Schools'],
          ['Deleted by', 'dana@ridgeview.test'],
        ],
      },
    ]);
  });
});

describe('renderGbdUserDeleted', () => {
  test('names the deleted account', () => {
    const document = renderGbdUserDeleted({
      kind: 'gbd-user-deleted',
      userEmail: 'dana@ridgeview.test',
    });

    expect(document.heading).toBe('User deleted: dana@ridgeview.test');
    expect(document.blocks).toEqual([
      {
        block: 'paragraph',
        text: 'Their reports remain with their organizations, showing a deleted user as the submitter.',
      },
      { block: 'facts', facts: [['Account', 'dana@ridgeview.test']] },
    ]);
  });
});
