// SPDX-License-Identifier: Apache-2.0

import { useEffect } from "react";
import type { BreadcrumbEntry } from "../stores/breadcrumb-store";

const APP_NAME = "Appstrate";

/** The tab's title: where the header's trail ends (a page's or a detail bar's own title), else the app's name. */
export function documentTitle(trail: readonly BreadcrumbEntry[]): string {
  // A slot counts once it carries its label (a conversation's title); while it loads its label is empty.
  const named = trail.filter((crumb) => crumb.label);
  const current = named[named.length - 1];
  return current ? `${current.label} · ${APP_NAME}` : APP_NAME;
}

/** Fed by the trail the shell draws, so no page opts in. */
export function useDocumentTitle(trail: readonly BreadcrumbEntry[]) {
  const title = documentTitle(trail);
  useEffect(() => {
    document.title = title;
  }, [title]);
}
