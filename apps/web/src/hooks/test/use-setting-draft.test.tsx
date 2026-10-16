// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { useState } from "react";
import { render } from "../../test/render.tsx";
import { useSettingDraft } from "../use-setting-draft.ts";

type Value = { name: string; locked: string[] };
type Draft = ReturnType<typeof useSettingDraft<Value>>;
const original: Value = { name: "stored", locked: [] };
const refreshed: Value = { name: "remote", locked: ["name"] };

/** Drive React state transitions without a DOM; each step is one edit/refetch/response. */
function exercise(actions: Array<(draft: Draft) => void>, remoteAt = Infinity) {
  function Probe() {
    const [step, setStep] = useState(0);
    const draft = useSettingDraft(step >= remoteAt ? refreshed : original);
    if (step < actions.length) {
      actions[step]!(draft);
      setStep(step + 1);
    }
    return null;
  }
  render(<Probe />);
}

describe("manual setting drafts", () => {
  it("stages an edit, detects reverting it, and never invokes a persistence callback", () => {
    exercise([
      (draft) => {
        expect(draft.dirty).toBe(false);
        draft.set({ ...original, name: "typed" });
      },
      (draft) => {
        expect(draft.value.name).toBe("typed");
        expect(draft.dirty).toBe(true);
        draft.set(original);
      },
      (draft) => expect(draft.dirty).toBe(false),
    ]);
  });
  it("keeps a dirty edit across a refetch and cancels to the latest stored state", () => {
    exercise(
      [
        (draft) => draft.set({ ...original, name: "typed" }),
        () => {},
        (draft) => {
          expect(draft.value.name).toBe("typed");
          expect(draft.dirty).toBe(true);
          draft.reset();
        },
        (draft) => {
          expect(draft.value).toEqual(refreshed);
          expect(draft.dirty).toBe(false);
        },
      ],
      2,
    );
  });
  it("keeps an edit made while a previous save was awaiting its refresh", () => {
    const sent = { ...original, name: "sent" };
    exercise([
      (draft) => draft.set(sent),
      (draft) => draft.set({ ...sent, name: "newer" }),
      (draft) => draft.accept(sent),
      (draft) => {
        expect(draft.value.name).toBe("newer");
        expect(draft.dirty).toBe(true);
        expect(draft.baseline).toEqual(sent);
      },
    ]);
  });
  it("follows remote data while clean", () => {
    exercise([() => {}, () => {}, (draft) => expect(draft.value).toEqual(refreshed)], 1);
  });
  it("accepts the successful sent value without waiting for a refetch", () => {
    exercise([
      (draft) => draft.set({ ...original, name: "saved" }),
      (draft) => draft.accept(draft.value),
      (draft) => {
        expect(draft.value.name).toBe("saved");
        expect(draft.dirty).toBe(false);
      },
    ]);
  });
});
