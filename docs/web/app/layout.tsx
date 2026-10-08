// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { GeistSans } from 'geist/font/sans';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { DocsLayout } from 'fumadocs-ui/layouts/notebook';
import { baseOptions } from '@/app/layout.config';
import { NavTabs } from '@/components/nav-tabs';
import { ScrollToTop } from '@/components/scroll-to-top';
import { SITE_NAME, SITE_URL, TWITTER_HANDLE } from '@/lib/site';
import { source } from '@/lib/source';
import './global.css';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'Appstrate Documentation',
    template: '%s · Appstrate Docs',
  },
  description: 'Appstrate documentation: concepts, guides, API reference, and self-hosting.',
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon-96x96.png', sizes: '96x96', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
  manifest: '/site.webmanifest',
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    url: SITE_URL,
  },
  twitter: {
    card: 'summary',
    site: TWITTER_HANDLE,
    creator: TWITTER_HANDLE,
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={GeistSans.variable} suppressHydrationWarning>
      <body suppressHydrationWarning>
        <RootProvider
          theme={{ defaultTheme: 'dark', enableSystem: false }}
          // Static export: the index is a JSON file built at build time
          // (app/search.json/route.ts) and queried in the browser.
          search={{ options: { type: 'static', api: '/search.json' } }}
        >
          <ScrollToTop />
          <DocsLayout
            {...baseOptions}
            tree={source.pageTree}
            nav={{ ...baseOptions.nav, mode: 'top', children: <NavTabs key="nav-tabs" /> }}
            tabs={false}
          >
            {children}
          </DocsLayout>
        </RootProvider>
      </body>
    </html>
  );
}
