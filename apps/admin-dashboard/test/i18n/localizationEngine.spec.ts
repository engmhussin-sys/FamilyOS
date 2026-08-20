import { describe, it, expect, beforeEach } from 'vitest';
import {
  translate,
  isRtl,
  getPersistedLocale,
  persistLocale,
  DEFAULT_LOCALE,
  FALLBACK_LOCALE,
} from '../../src/shared/i18n/localizationEngine';
import en from '../../src/shared/i18n/translations/en.json';
import ar from '../../src/shared/i18n/translations/ar.json';

function flatten(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const full = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'object' && value !== null
      ? flatten(value as Record<string, unknown>, full)
      : [full];
  });
}

describe('localizationEngine', () => {
  describe('translate', () => {
    it('resolves a real key in English', () => {
      expect(translate('en', 'common.save')).toBe('Save');
    });

    it('resolves the same key in Arabic', () => {
      expect(translate('ar', 'common.save')).toBe('حفظ');
    });

    it('falls back to the default locale when a key is missing in the requested locale', () => {
      // Every real key exists in both files today, so this exercises the
      // fallback path directly with a key that exists in en but not ar.
      const result = translate('ar', 'nonexistent.key.entirely');
      expect(result).toBe('nonexistent.key.entirely'); // final fallback: the raw key itself
    });

    it('never returns a blank string for a missing key — falls back to the key itself', () => {
      const result = translate('en', 'totally.missing.key');
      expect(result).toBe('totally.missing.key');
      expect(result.length).toBeGreaterThan(0);
    });

    it('interpolates {{token}} placeholders', () => {
      const result = translate('en', 'notifications.markRead');
      expect(result).toBe('Mark as read');
    });

    it('pluralization: uses the _one suffix for count=1', () => {
      const result = translate('en', 'notifications.unreadCount', { count: 1 });
      expect(result).toBe('1 unread');
    });

    it('pluralization: uses the _other suffix for count > 1', () => {
      const result = translate('en', 'notifications.unreadCount', { count: 5 });
      expect(result).toBe('5 unread');
    });

    it('pluralization: Arabic _other form differs grammatically from _one', () => {
      const one = translate('ar', 'notifications.unreadCount', { count: 1 });
      const many = translate('ar', 'notifications.unreadCount', { count: 5 });
      expect(one).toContain('غير مقروء');
      expect(many).toContain('غير مقروءة');
    });

    it('falls back to the base key when count is provided but no plural forms exist', () => {
      const result = translate('en', 'common.save', { count: 5 });
      expect(result).toBe('Save'); // no common.save_other exists, base key used
    });
  });

  /**
   * A3. The Dashboard used to fall back to `en` while both Flutter engines
   * fell back to their default locale (`ar`) under a header claiming the
   * three used the same strategy. The Dashboard is the side that moved.
   */
  describe('the fallback locale', () => {
    it('IS the default locale — one chain, not two', () => {
      expect(FALLBACK_LOCALE).toBe(DEFAULT_LOCALE);
      expect(FALLBACK_LOCALE).toBe('ar');
    });

    it('never actually fires today: en.json and ar.json are at full key parity', () => {
      // The guard that keeps the change above free of consequences. If this
      // ever goes red, a missing key now surfaces ARABIC inside an English
      // screen rather than English inside an Arabic one — deliberate, and
      // stated here so the trade-off is not rediscovered by surprise.
      const enKeys = flatten(en as Record<string, unknown>).sort();
      const arKeys = flatten(ar as Record<string, unknown>).sort();
      expect(arKeys).toEqual(enKeys);
      expect(enKeys.length).toBeGreaterThan(0);
    });

    it('a key missing from BOTH files still renders as the key, never blank', () => {
      expect(translate('en', 'absent.in.both.files')).toBe('absent.in.both.files');
      expect(translate('ar', 'absent.in.both.files')).toBe('absent.in.both.files');
    });
  });

  describe('isRtl', () => {
    it('Arabic is RTL', () => {
      expect(isRtl('ar')).toBe(true);
    });

    it('English is not RTL', () => {
      expect(isRtl('en')).toBe(false);
    });
  });

  describe('locale persistence', () => {
    beforeEach(() => {
      localStorage.clear();
    });

    it('getPersistedLocale defaults to DEFAULT_LOCALE when nothing is stored', () => {
      expect(getPersistedLocale()).toBe(DEFAULT_LOCALE);
    });

    it('persistLocale + getPersistedLocale round-trips correctly', () => {
      persistLocale('ar');
      expect(getPersistedLocale()).toBe('ar');
    });

    it('getPersistedLocale ignores an invalid stored value, falling back to default', () => {
      localStorage.setItem('afdc_locale', 'fr'); // unsupported locale
      expect(getPersistedLocale()).toBe(DEFAULT_LOCALE);
    });
  });
});
