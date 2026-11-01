/**
 * Filter lists AETHER can download. Lists are fetched at runtime from their
 * publishers, never bundled into the installer, so their copyleft licences apply to
 * the list data the user downloads rather than to AETHER's own code. Every list is
 * shown in settings with its source and licence.
 */

export type ListCategory = 'ads' | 'tracking' | 'annoyances';

export interface FilterListSource {
  id: string;
  name: string;
  category: ListCategory;
  /** Tried in order. The first entry is the publisher's canonical URL. */
  urls: string[];
  license: string;
  homepage: string;
}

const GHOSTERY_MIRROR = 'https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets';

export const FILTER_LISTS: readonly FilterListSource[] = [
  {
    id: 'easylist',
    name: 'EasyList',
    category: 'ads',
    urls: ['https://easylist.to/easylist/easylist.txt', `${GHOSTERY_MIRROR}/easylist/easylist.txt`],
    license: 'GPL-3.0-or-later OR CC-BY-SA-3.0',
    homepage: 'https://easylist.to/',
  },
  {
    id: 'ubo-filters',
    name: 'uBlock filters',
    category: 'ads',
    urls: [
      'https://ublockorigin.github.io/uAssets/filters/filters.txt',
      `${GHOSTERY_MIRROR}/ublock-origin/filters.txt`,
    ],
    license: 'GPL-3.0',
    homepage: 'https://github.com/uBlockOrigin/uAssets',
  },
  {
    id: 'ubo-unbreak',
    name: 'uBlock filters: unbreak',
    category: 'ads',
    urls: [
      'https://ublockorigin.github.io/uAssets/filters/unbreak.txt',
      `${GHOSTERY_MIRROR}/ublock-origin/unbreak.txt`,
    ],
    license: 'GPL-3.0',
    homepage: 'https://github.com/uBlockOrigin/uAssets',
  },
  {
    id: 'ubo-quick-fixes',
    name: 'uBlock filters: quick fixes (video and anti-adblock)',
    category: 'ads',
    urls: [
      'https://ublockorigin.github.io/uAssets/filters/quick-fixes.txt',
      `${GHOSTERY_MIRROR}/ublock-origin/quick-fixes.txt`,
    ],
    license: 'GPL-3.0',
    homepage: 'https://github.com/uBlockOrigin/uAssets',
  },
  {
    id: 'ubo-filters-2023',
    name: 'uBlock filters: 2023',
    category: 'ads',
    urls: [
      'https://ublockorigin.github.io/uAssets/filters/filters-2023.txt',
      `${GHOSTERY_MIRROR}/ublock-origin/filters-2023.txt`,
    ],
    license: 'GPL-3.0',
    homepage: 'https://github.com/uBlockOrigin/uAssets',
  },
  {
    id: 'ubo-filters-2024',
    name: 'uBlock filters: 2024',
    category: 'ads',
    urls: [
      'https://ublockorigin.github.io/uAssets/filters/filters-2024.txt',
      `${GHOSTERY_MIRROR}/ublock-origin/filters-2024.txt`,
    ],
    license: 'GPL-3.0',
    homepage: 'https://github.com/uBlockOrigin/uAssets',
  },
  {
    id: 'ubo-badware',
    name: 'uBlock filters: badware risks',
    category: 'ads',
    urls: [
      'https://ublockorigin.github.io/uAssets/filters/badware.txt',
      `${GHOSTERY_MIRROR}/ublock-origin/badware.txt`,
    ],
    license: 'GPL-3.0',
    homepage: 'https://github.com/uBlockOrigin/uAssets',
  },
  {
    id: 'ubo-resource-abuse',
    name: 'uBlock filters: resource abuse (cryptominers)',
    category: 'ads',
    urls: [
      'https://ublockorigin.github.io/uAssets/filters/resource-abuse.txt',
      `${GHOSTERY_MIRROR}/ublock-origin/resource-abuse.txt`,
    ],
    license: 'GPL-3.0',
    homepage: 'https://github.com/uBlockOrigin/uAssets',
  },
  {
    id: 'easyprivacy',
    name: 'EasyPrivacy',
    category: 'tracking',
    urls: ['https://easylist.to/easylist/easyprivacy.txt', `${GHOSTERY_MIRROR}/easylist/easyprivacy.txt`],
    license: 'GPL-3.0-or-later OR CC-BY-SA-3.0',
    homepage: 'https://easylist.to/',
  },
  {
    id: 'ubo-privacy',
    name: 'uBlock filters: privacy',
    category: 'tracking',
    urls: [
      'https://ublockorigin.github.io/uAssets/filters/privacy.txt',
      `${GHOSTERY_MIRROR}/ublock-origin/privacy.txt`,
    ],
    license: 'GPL-3.0',
    homepage: 'https://github.com/uBlockOrigin/uAssets',
  },
  {
    id: 'easylist-cookie',
    name: 'EasyList Cookie (consent banners)',
    category: 'annoyances',
    urls: ['https://secure.fanboy.co.nz/fanboy-cookiemonster.txt', `${GHOSTERY_MIRROR}/easylist/easylist-cookie.txt`],
    license: 'GPL-3.0-or-later OR CC-BY-SA-3.0',
    homepage: 'https://easylist.to/',
  },
  {
    id: 'ubo-annoyances',
    name: 'uBlock filters: annoyances',
    category: 'annoyances',
    urls: [
      'https://ublockorigin.github.io/uAssets/filters/annoyances-others.txt',
      `${GHOSTERY_MIRROR}/ublock-origin/annoyances-others.txt`,
    ],
    license: 'GPL-3.0',
    homepage: 'https://github.com/uBlockOrigin/uAssets',
  },
];

export function listsForCategories(categories: { ads: boolean; tracking: boolean; annoyances: boolean }): FilterListSource[] {
  return FILTER_LISTS.filter((l) => categories[l.category]);
}
