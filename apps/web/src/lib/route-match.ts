// SPDX-License-Identifier: Apache-2.0

import { matchRoutes } from "react-router-dom";
import { ROUTE_ACCESS, type RoutePath } from "./route-access";

const ROUTES = Object.keys(ROUTE_ACCESS).map((path) => ({ path }));

/**
 * The declared route a link target lands on: a pattern as is, a concrete URL
 * ranked the way the router ranks it (`/agents/new` before `/agents/:scope`).
 * `undefined` for a URL no declaration covers — outside the main layout.
 */
export function routeOf(target: string): RoutePath | undefined {
  if (Object.prototype.hasOwnProperty.call(ROUTE_ACCESS, target)) return target as RoutePath;
  return matchRoutes(ROUTES, target)?.[0]?.route.path as RoutePath | undefined;
}
