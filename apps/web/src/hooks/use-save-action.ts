// SPDX-License-Identifier: Apache-2.0

import { useRef, useState } from "react";

/**
 * One save at a time: the leave dialog's Save joins a write already in flight. A refusal is
 * told by the mutation's own toast (`lib/query-client.ts`); the draft stays for a retry.
 */
export function useSaveAction(onSave: () => Promise<void>) {
  const [saving, setSaving] = useState(false);
  const inFlight = useRef<Promise<void> | null>(null);
  const save = () => {
    if (inFlight.current) return inFlight.current;
    setSaving(true);
    const work = onSave().finally(() => {
      inFlight.current = null;
      setSaving(false);
    });
    inFlight.current = work;
    return work;
  };
  return { save, saving };
}
