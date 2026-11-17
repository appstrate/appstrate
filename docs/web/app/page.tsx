// SPDX-License-Identifier: Apache-2.0

import { redirect } from 'next/navigation';
import { HOME_PATH } from '@/lib/site';

// Cloudflare answers `/` with a real redirect (public/_redirects); this static
// fallback covers `next dev` and any host that ignores that file.
export default function Home() {
  redirect(HOME_PATH);
}
