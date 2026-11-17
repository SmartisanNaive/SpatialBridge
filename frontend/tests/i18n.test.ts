import assert from 'node:assert/strict';
import test from 'node:test';
import {zh} from '../src/i18n/locales/zh.ts';
import {en} from '../src/i18n/locales/en.ts';

function checkKeys(zhObj: Record<string, unknown>, enObj: Record<string, unknown>, path = '') {
  for (const key of Object.keys(zhObj)) {
    const currentPath = path ? `${path}.${key}` : key;
    assert.ok(key in enObj, `Missing key in en: ${currentPath}`);
    const zhVal = zhObj[key];
    const enVal = enObj[key];
    assert.equal(typeof enVal, typeof zhVal, `Type mismatch for key ${currentPath}`);
    if (typeof zhVal === 'object' && zhVal !== null && !Array.isArray(zhVal)) {
      checkKeys(zhVal as Record<string, unknown>, enVal as Record<string, unknown>, currentPath);
    }
  }
}

test('i18n zh and en locales have matching keys and structural parity', () => {
  checkKeys(zh as unknown as Record<string, unknown>, en as unknown as Record<string, unknown>);
  checkKeys(en as unknown as Record<string, unknown>, zh as unknown as Record<string, unknown>);
});
