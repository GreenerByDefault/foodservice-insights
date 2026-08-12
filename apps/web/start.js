/** Entry point in lieu of `node build/index.js`, so `BODY_SIZE_LIMIT` can be derived from
 * `MAX_UPLOAD_BYTES` instead of living in an env var someone has to remember to set.
 *
 * adapter-node's generated `build/index.js` reads `BODY_SIZE_LIMIT` from `process.env` as soon
 * as it — or anything that imports it — is loaded, so the value has to happen before the dynamic
 * `import` below.
 */

import { MAX_UPLOAD_BYTES } from './upload-limit.js';

/** Extra room for the multipart overhead around the file itself — field names, the boundary,
 * and the report metadata — so a file at the product limit still reaches our own validation.
 */
const MULTIPART_OVERHEAD_BYTES = 2 * 1024 * 1024;

process.env.BODY_SIZE_LIMIT = String(MAX_UPLOAD_BYTES + MULTIPART_OVERHEAD_BYTES);

await import('./build/index.js');
