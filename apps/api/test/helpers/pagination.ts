// SPDX-License-Identifier: Apache-2.0

interface RequestApp {
  request(input: string, init?: RequestInit): Response | Promise<Response>;
}

/**
 * Follow the RFC 5988 `Link: rel="next"` chain from `path` to the last page and
 * return every page's JSON body. Each page must answer 200; the walk is bounded
 * so a pagination bug fails instead of hanging.
 */
export async function walkLinkPages<T>(
  app: RequestApp,
  path: string,
  headers: Record<string, string>,
  maxPages = 20,
): Promise<T[]> {
  const pages: T[] = [];
  let url: string | null = path;
  while (url) {
    if (pages.length === maxPages) throw new Error(`walkLinkPages: over ${maxPages} pages`);
    const res = await app.request(url, { headers });
    if (res.status !== 200) throw new Error(`walkLinkPages: ${url} answered ${res.status}`);
    pages.push((await res.json()) as T);
    const next = res.headers.get("Link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
    url = next ? `${new URL(next).pathname}${new URL(next).search}` : null;
  }
  return pages;
}
