/** Stop the dev Grafana that `pnpm grafana` leaves running, to free the memory it holds.
 *
 *   pnpm grafana:stop
 */

import { DEV_GRAFANA, stopGrafana } from '../src/local-grafana.ts';

await stopGrafana(DEV_GRAFANA);
