/** A 32-byte checksum, the only length `checksum_sha256` accepts. */
export function aChecksum(): Buffer {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
}
