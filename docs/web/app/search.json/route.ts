// SPDX-License-Identifier: Apache-2.0

import { createFromSource } from 'fumadocs-core/search/server';
import { source } from '@/lib/source';

// Emitted once at build time as a static file (`out/search.json`, served
// compressed as JSON), which the search dialog downloads on first use and
// queries in the browser.
export const revalidate = false;

export const { staticGET: GET } = createFromSource(source, {
  language: 'english',
});
