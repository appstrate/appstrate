// SPDX-License-Identifier: Apache-2.0

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { title: 'Docs', url: '/get-started/introduction', section: null },
  { title: 'API', url: '/api/introduction', section: '/api' },
  { title: 'Resources', url: '/resources/architecture', section: '/resources' },
];

const inSection = (pathname: string, section: string) =>
  pathname === section || pathname.startsWith(`${section}/`);

// Docs is the catch-all: active everywhere outside the API and Resources sections.
function isActive(pathname: string, section: string | null) {
  if (section) return inSection(pathname, section);
  return !TABS.some((tab) => tab.section && inSection(pathname, tab.section));
}

export function NavTabs() {
  const pathname = usePathname();
  return (
    <nav className="flex items-stretch gap-6 ms-10 max-md:hidden h-full" aria-label="Sections">
      {TABS.map((tab) => {
        const active = isActive(pathname, tab.section);
        return (
          <Link
            key={tab.url}
            href={tab.url}
            aria-current={active ? 'page' : undefined}
            className={`inline-flex items-center text-sm transition-colors border-b-2 -mb-px ${
              active
                ? 'text-fd-primary border-fd-primary font-medium'
                : 'text-fd-muted-foreground border-transparent hover:text-fd-accent-foreground'
            }`}
          >
            {tab.title}
          </Link>
        );
      })}
    </nav>
  );
}
