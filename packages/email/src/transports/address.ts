/** Splitting `Name <address@example.org>` into its parts.
 *
 * `EMAIL_FROM` is configured as one string because that is how a sender is written everywhere else
 * — in a provider's dashboard, in an SMTP header — but the JSON APIs we post to want the two
 * separately.
 */

export type Address = {
  address: string;
  /** Empty when the configured value is a bare address. */
  name: string;
};

const ANGLE_BRACKETS = /^\s*(.*?)\s*<\s*([^>]+)\s*>\s*$/;

export function parseAddress(value: string): Address {
  const match = ANGLE_BRACKETS.exec(value);
  if (match === null) return { address: value.trim(), name: '' };

  const [, name = '', address = ''] = match;
  // Display names are commonly quoted, and the quotes are syntax rather than part of the name.
  return { address: address.trim(), name: name.replace(/^"(.*)"$/, '$1') };
}
