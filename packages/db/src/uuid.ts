/** UUID v7, per RFC 9562 §5.7: 48 bits of Unix milliseconds, then 74 random bits.
 *
 * Deliberately a second implementation of the `uuidv7()` SQL function in
 * [`migrations/001_initial_schema.ts`](../migrations/001_initial_schema.ts), which is what every
 * `uuidv7`-defaulted column uses. Two implementations are fine here: the layout is frozen by the
 * RFC, and the alternative is a database round trip for every id on a path that has to know the
 * id before it writes anything.
 *
 * Both can go away on Postgres 18, which has `uuidv7()` built in.
 */
export function uuidV7(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const view = new DataView(bytes.buffer);

  // Bytes 0-5 are the timestamp, big-endian. Written as 32 bits then 16 rather than in one go,
  // because milliseconds since the epoch needs 41 bits and `setUint32` would truncate it.
  const milliseconds = Date.now();
  view.setUint32(0, Math.floor(milliseconds / 0x1_0000));
  view.setUint16(4, milliseconds % 0x1_0000);

  // The version and variant fields overwrite 6 of the random bits, which is what leaves 74
  // rather than 80.
  view.setUint8(6, (view.getUint8(6) & 0x0f) | 0x70);
  view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80);

  const hex = Buffer.from(bytes).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

/** The milliseconds `uuidV7` embedded, for tests and debugging. Meaningless for a v4 id. */
export function uuidV7Timestamp(uuid: string): number {
  return Number.parseInt(uuid.slice(0, 8) + uuid.slice(9, 13), 16);
}
