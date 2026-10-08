/**
 * Turns whatever a buyer typed into the one shape an SMS provider accepts.
 *
 * "Given I provided a mobile number and SMS is applicable" (US-DISC-06 AC5) is
 * read here as: it is a THAI MOBILE. Nothing normalises the number upstream —
 * eventa-api stores the raw text from the checkout form — so this is the only
 * place that decides whether there is a number worth paying to text.
 *
 * Refusing is the safe answer. A landline or a foreign number handed to a
 * provider is billed and delivered to nobody, and a misread digit reaches a
 * stranger with somebody's booking reference.
 */

/** Thailand. The only country this product texts today. */
const COUNTRY_CODE = '66';

/** A Thai national subscriber number, after the trunk zero: 9 digits. */
const NATIONAL_DIGITS = 9;

/**
 * The first digit of a Thai MOBILE number, once the trunk zero is off: 06, 08
 * and 09 are mobile ranges. Everything else (02 Bangkok, 03x–05x, 07x) is a
 * landline, which cannot receive a text.
 */
const MOBILE_LEADING_DIGITS = ['6', '8', '9'];

/** Separators a person types and a provider will not accept. */
const SEPARATORS = /[\s\-.()]/g;

/**
 * `+66812345678`, or null when this is not a Thai mobile.
 *
 * Accepts the forms a Thai booking form actually collects: `0812345678`,
 * `+66812345678`, `66812345678`, `0066812345678`, and `+660812345678` — the
 * stray trunk zero somebody leaves when they put `+66` in front of the number
 * they know by heart.
 */
export function toThaiMobileE164(raw: string): string | null {
  const cleaned = raw.replace(SEPARATORS, '');
  if (!/^\+?\d+$/.test(cleaned)) return null;

  const national = nationalPart(cleaned.replace(/^\+/, ''));
  if (national === null) return null;
  if (national.length !== NATIONAL_DIGITS) return null;
  if (!MOBILE_LEADING_DIGITS.includes(national[0])) return null;

  return `+${COUNTRY_CODE}${national}`;
}

/**
 * The subscriber digits, with the international prefix and the trunk zero
 * stripped. Null when the number belongs to another country: a `+1` or `+65`
 * is a real mobile, just not one this product has decided how to text.
 */
function nationalPart(digits: string): string | null {
  const withoutIdd = digits.startsWith('00') ? digits.slice(2) : digits;

  if (withoutIdd.startsWith(COUNTRY_CODE)) {
    // `+660812345678` — the writer kept the trunk zero after the country code.
    return withoutIdd.slice(COUNTRY_CODE.length).replace(/^0/, '');
  }
  if (withoutIdd.startsWith('0')) return withoutIdd.slice(1);

  // Neither a Thai country code nor a national trunk zero: not ours to send.
  return null;
}
