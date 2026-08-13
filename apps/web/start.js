/** Entry point in lieu of `node build/index.js`, so `BODY_SIZE_LIMIT` can be derived from
 * `MAX_UPLOAD_BYTES` instead of living in an env var someone has to remember to set. Whatever
 * starts the server in production must run this file, not `build/index.js` — that one reads the
 * env var we are setting here, and without it falls back to adapter-node's 512KB default.
 */

import { MAX_UPLOAD_BYTES, TRANSPORT_MARGIN_BYTES } from './src/lib/reports/upload-limit.js';

process.env.BODY_SIZE_LIMIT = String(MAX_UPLOAD_BYTES + TRANSPORT_MARGIN_BYTES);

// Dynamic, and below the assignment: `build/index.js` reads `BODY_SIZE_LIMIT` at module scope, so
// a static import would hoist above it and read the default instead.
await import('./build/index.js');
