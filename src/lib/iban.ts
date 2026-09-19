export const normalizeIban = (value: string): string => value.replace(/\s/g, '').toUpperCase();

// Checks the Turkish IBAN structure and ISO 7064 MOD 97-10 checksum.
// A valid checksum does not establish that the bank account exists.
export function getTryIbanError(value: string): string | null {
  const iban = normalizeIban(value);
  if (!iban) return 'Enter the recipient IBAN.';
  if (!/^TR\d{7}0[A-Z0-9]{16}$/.test(iban)) {
    return 'Enter a Turkish IBAN with 26 characters, starting with TR.';
  }

  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const character of rearranged) {
    const digits = /[A-Z]/.test(character) ? String(character.charCodeAt(0) - 55) : character;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1
    ? null
    : 'The IBAN check digits do not match. Check the full IBAN; changing an account digit also changes its check digits.';
}
