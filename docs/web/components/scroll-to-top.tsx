// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';

/**
 * Scroll to top on every client-side navigation.
 *
 * Next.js App Router preserves per-URL scroll position in session history,
 * so clicking a doc link lands the reader wherever they left the destination
 * page last time. For docs, that's disorienting: the reader expects a fresh
 * page to start at the top. Only the main content area is reset; the
 * sidebar keeps its own scroll position so the active item stays in view.
 */
export function ScrollToTop() {
  const pathname = usePathname();

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.location.hash) return;

    window.scrollTo({ top: 0, behavior: 'smooth' });

    document
      .querySelectorAll<HTMLElement>('main, article')
      .forEach((el) => {
        if (el.scrollTop > 0) el.scrollTo({ top: 0, behavior: 'smooth' });
      });
  }, [pathname]);

  return null;
}
