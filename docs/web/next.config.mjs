// SPDX-License-Identifier: Apache-2.0

import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // A static site: Cloudflare Pages serves `out/`. Redirects live in
  // public/_redirects and the /errors resolver in functions/, not here.
  output: 'export',
  // This app is outside the monorepo workspaces and has its own lockfile.
  turbopack: { root: import.meta.dirname },
  outputFileTracingRoot: import.meta.dirname,
};

export default withMDX(nextConfig);
