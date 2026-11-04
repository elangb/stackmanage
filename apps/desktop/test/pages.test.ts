import { describe, expect, it } from 'vitest';
import { messages } from '@stackmanage/i18n';
import { NAV_GROUPS, PAGE_TITLE_KEYS } from '../src/renderer/pages';

describe('navigation contract', () => {
  it('marks only implemented views as available', () => {
    const implemented = NAV_GROUPS.flatMap(group => group.items).filter(item => item.implemented).map(item => item.key);
    expect(implemented).toEqual(['home', 'runtimes', 'web', 'databases', 'settings']);
  });

  it('has a title key for every page and a translation for every nav label', () => {
    const pages = NAV_GROUPS.flatMap(group => group.items).map(item => item.key);
    expect(Object.keys(PAGE_TITLE_KEYS).sort()).toEqual([...pages].sort());
    for (const item of NAV_GROUPS.flatMap(group => group.items)) {
      expect(messages.en[item.labelKey as keyof typeof messages.en]).toBeTruthy();
    }
  });

  it('does not expose a duplicate page key', () => {
    const pages = NAV_GROUPS.flatMap(group => group.items).map(item => item.key);
    expect(new Set(pages).size).toBe(pages.length);
  });
});
