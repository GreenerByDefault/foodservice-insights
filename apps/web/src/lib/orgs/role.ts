/** The role a request body names, shared by invite and change-role. */

import type { OrganizationRole } from '@gbd/db';
import * as v from 'valibot';

export const OrganizationRoleSchema = v.picklist(['admin', 'member'] satisfies OrganizationRole[]);
