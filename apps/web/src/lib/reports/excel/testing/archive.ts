/** A workbook whose zip central directory *lies* about how much it unpacks to, for the tests that
 * prove the unpacked cap is checked before anything is inflated. Every XML payload is scribbled
 * over, so a reader that decompresses this archive can only call it corrupt — reporting a
 * declared size at all is proof the central directory was read alone.
 */

import { aWorkbook } from './workbook.ts';

// Offsets within a zip central-directory file header, per PKZIP's APPNOTE.txt § 4.3.12.
const CENTRAL_SIGNATURE = 0x0201_4b50;
const CENTRAL_COMPRESSED_SIZE = 20;
const CENTRAL_UNCOMPRESSED_SIZE = 24;
const CENTRAL_NAME_LENGTH = 28;
const CENTRAL_LOCAL_OFFSET = 42;
const CENTRAL_NAME = 46;

// And within a local file header, § 4.3.7.
const LOCAL_NAME_LENGTH = 26;
const LOCAL_EXTRA_LENGTH = 28;
const LOCAL_NAME = 30;

const XML_ENTRY = /\.xml(\.rels)?$/;

/** Every other XML entry is rewritten to declare zero bytes, so the archive's declared total is
 * exactly the sum of the values passed here and a test can assert it. */
export function aWorkbookDeclaring(entries: Readonly<Record<string, number>>): Uint8Array {
  const bytes = new Uint8Array(aWorkbook([['product'], ['beef']]));
  for (const record of centralRecords(bytes)) {
    if (!XML_ENTRY.test(record.name)) continue;
    declare(bytes, record, entries[record.name] ?? 0);
  }
  const declared = new Set(centralRecords(bytes).map(({ name }) => name));
  for (const name of Object.keys(entries)) {
    if (!declared.has(name)) throw new Error(`no zip entry named "${name}"`);
  }
  return bytes;
}

type CentralRecord = { at: number; name: string };

function declare(bytes: Uint8Array, { at }: CentralRecord, declaredBytes: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const compressedSize = view.getUint32(at + CENTRAL_COMPRESSED_SIZE, true);
  view.setUint32(at + CENTRAL_UNCOMPRESSED_SIZE, declaredBytes, true);

  const local = view.getUint32(at + CENTRAL_LOCAL_OFFSET, true);
  const payload =
    local +
    LOCAL_NAME +
    view.getUint16(local + LOCAL_NAME_LENGTH, true) +
    view.getUint16(local + LOCAL_EXTRA_LENGTH, true);
  bytes.fill(0xff, payload, payload + compressedSize);
}

function centralRecords(bytes: Uint8Array): CentralRecord[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const records: CentralRecord[] = [];
  for (let at = 0; at + CENTRAL_NAME <= bytes.byteLength; at += 1) {
    if (view.getUint32(at, true) !== CENTRAL_SIGNATURE) continue;
    const length = view.getUint16(at + CENTRAL_NAME_LENGTH, true);
    records.push({
      at,
      name: decoder.decode(bytes.subarray(at + CENTRAL_NAME, at + CENTRAL_NAME + length)),
    });
  }
  return records;
}
