import { toThaiMobileE164 } from './thai-mobile';

/**
 * The gate every confirmation text passes through (US-DISC-06). "SMS is
 * applicable" is read here as "this is a Thai mobile": everything else is
 * refused rather than guessed at, because a number sent to a provider in the
 * wrong shape is a charge for a message nobody receives.
 */
describe('toThaiMobileE164', () => {
  describe('a Thai mobile, however it was typed', () => {
    it('accepts the national form, with or without separators', () => {
      expect(toThaiMobileE164('0812345678')).toBe('+66812345678');
      expect(toThaiMobileE164('081-234-5678')).toBe('+66812345678');
      expect(toThaiMobileE164('081 234 5678')).toBe('+66812345678');
      expect(toThaiMobileE164('(081) 234-5678')).toBe('+66812345678');
      expect(toThaiMobileE164('081.234.5678')).toBe('+66812345678');
    });

    it('accepts the international forms a booking form collects', () => {
      expect(toThaiMobileE164('+66812345678')).toBe('+66812345678');
      expect(toThaiMobileE164('+66 81 234 5678')).toBe('+66812345678');
      expect(toThaiMobileE164('66812345678')).toBe('+66812345678');
      expect(toThaiMobileE164('0066812345678')).toBe('+66812345678');
    });

    it('accepts a stray trunk zero left after the country code', () => {
      // What somebody typing +66 in front of the number they know produces.
      expect(toThaiMobileE164('+660812345678')).toBe('+66812345678');
    });

    it('accepts every Thai mobile prefix, not just 08', () => {
      expect(toThaiMobileE164('0612345678')).toBe('+66612345678');
      expect(toThaiMobileE164('0912345678')).toBe('+66912345678');
    });
  });

  describe('what is not a Thai mobile', () => {
    it('refuses a landline', () => {
      // Texting a Bangkok landline costs money and reaches nobody.
      expect(toThaiMobileE164('021234567')).toBeNull();
      expect(toThaiMobileE164('053123456')).toBeNull();
      expect(toThaiMobileE164('0712345678')).toBeNull();
    });

    it('refuses a number of the wrong length', () => {
      expect(toThaiMobileE164('081234567')).toBeNull();
      expect(toThaiMobileE164('08123456789')).toBeNull();
    });

    it('refuses a foreign number', () => {
      // Not "cannot be texted" — out of scope until somebody decides what
      // international delivery costs and which provider carries it.
      expect(toThaiMobileE164('+14155550123')).toBeNull();
      expect(toThaiMobileE164('+6591234567')).toBeNull();
    });

    it('refuses anything that is not a number at all', () => {
      expect(toThaiMobileE164('abc')).toBeNull();
      expect(toThaiMobileE164('')).toBeNull();
      expect(toThaiMobileE164('   ')).toBeNull();
      expect(toThaiMobileE164('0812345678 ext 2')).toBeNull();
    });
  });
});
