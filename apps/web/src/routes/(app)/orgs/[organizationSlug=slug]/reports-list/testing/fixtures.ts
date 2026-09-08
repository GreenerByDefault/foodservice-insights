import type { ReportListRow } from '../../+page.server.ts';

export function aReport(overrides: Partial<ReportListRow> = {}): ReportListRow {
  return {
    id: 'a4f8e2b0-1111-4a11-8111-000000000001' as ReportListRow['id'],
    href: '/orgs/org-1/reports/a4f8e2b0-1111-4a11-8111-000000000001',
    name: 'Q1 procurement',
    siteName: 'Riverside Cafeteria',
    creator: { displayName: 'Ana Ruiz', email: 'ana@example.test' },
    createdAt: new Date('2026-01-15T09:48:00Z'),
    status: 'pending',
    now: new Date('2026-01-15T10:00:00Z'),
    ...overrides,
  };
}
