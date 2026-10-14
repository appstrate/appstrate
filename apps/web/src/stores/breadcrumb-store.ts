// SPDX-License-Identifier: Apache-2.0

/**
 * The trail the shell header renders.
 *
 * Pages DECLARE their breadcrumbs through `PageHeader`'s `breadcrumbs` prop,
 * and `PageHeader` publishes them here rather than drawing them itself. That keeps the declaration next to the page that
 * knows its own dynamic labels (an agent's name, a run number), while the
 * drawing happens once, in the header, next to the org chip that opens the
 * trail.
 */
import { create } from "zustand";
import type { ReactNode } from "react";

export interface BreadcrumbEntry {
  label: string;
  href?: string;
  node?: ReactNode;
}

interface BreadcrumbState {
  entries: BreadcrumbEntry[];
  setEntries: (entries: BreadcrumbEntry[]) => void;
}

export const useBreadcrumbStore = create<BreadcrumbState>((set) => ({
  entries: [],
  setEntries: (entries) => set({ entries }),
}));
