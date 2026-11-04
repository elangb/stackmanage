import { expect, it } from 'vitest';
import { locales, messages } from '../src';

it('ships five complete locales with no empty UI labels', () => {
  expect(locales).toHaveLength(5);
  for (const locale of locales) {
    expect(Object.keys(messages[locale]).sort()).toEqual(Object.keys(messages.en).sort());
    for (const value of Object.values(messages[locale])) {
      if (typeof value === 'string') expect(value.trim().length).toBeGreaterThan(0);
      else expect(Object.keys(value).sort()).toEqual([...locales].sort());
    }
  }
});
