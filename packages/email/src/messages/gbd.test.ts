import { describe, expect, test } from 'vitest';
import {
  renderGbdOrganizationCreated,
  renderGbdOrganizationDeleted,
  renderGbdUserDeleted,
} from './gbd.ts';
import { renderText } from './layout.ts';

describe('renderGbdOrganizationCreated', () => {
  test('names the organization and who created it', () => {
    const document = renderGbdOrganizationCreated({
      kind: 'gbd-organization-created',
      organizationName: 'Ridgeview Schools',
      actorEmail: 'dana@ridgeview.test',
    });

    expect(document.heading).toBe('New organization: Ridgeview Schools');
    expect(renderText(document)).toContain('dana@ridgeview.test');
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
    const text = renderText(document);
    expect(text).toContain('dana@ridgeview.test');
    expect(text).toContain('No user accounts were');
  });
});

describe('renderGbdUserDeleted', () => {
  test('names the deleted account', () => {
    const document = renderGbdUserDeleted({
      kind: 'gbd-user-deleted',
      userEmail: 'dana@ridgeview.test',
    });

    expect(document.heading).toBe('User deleted: dana@ridgeview.test');
  });
});
