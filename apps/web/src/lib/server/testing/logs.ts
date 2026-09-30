import { collectingLogger } from '@gbd/core/testing';

/** Every record the server code under test wrote, cleared before each test. The setup file routes
 * `rootLogger()` here. */
export const SERVER_LOGS = collectingLogger();
