import { apiCall } from '$lib/api/fetch';
import { classifyNameWriteFailure } from './failure.ts';

export type CreateOrganizationOutcome =
  | { kind: 'created'; location: string }
  | { kind: 'name-taken' }
  | { kind: 'unknown' };

export async function createOrganization(name: string): Promise<CreateOrganizationOutcome> {
  try {
    const response = await apiCall('/api/orgs', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    return { kind: 'created', location: response.headers.get('location') ?? '/orgs' };
  } catch (error) {
    return classifyNameWriteFailure(error);
  }
}
