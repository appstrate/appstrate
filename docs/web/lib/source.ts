// SPDX-License-Identifier: Apache-2.0

import { loader } from 'fumadocs-core/source';
import { createOpenAPI } from 'fumadocs-openapi/server';
import * as icons from 'lucide-react';
import { createElement } from 'react';
import { docs } from '../.source/server';

// Served at the domain root: /get-started/introduction, /api/agents, ...
export const source = loader({
  baseUrl: '/',
  source: docs.toFumadocsSource(),
  icon(name) {
    if (name && name in icons) {
      return createElement(icons[name as keyof typeof icons] as icons.LucideIcon);
    }
  },
});

// Prepared for the reference by scripts/sync-content.ts.
export const openapi = createOpenAPI({
  input: ['./openapi.reference.json'],
});
