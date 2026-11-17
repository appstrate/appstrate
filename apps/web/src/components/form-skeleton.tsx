// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { Waiting } from "./loading-skeletons";

/**
 * A settings form while its read is on its way, drawn by the form itself: the
 * caller renders the real form from what it already holds (a listing's row),
 * inert, with every control greyed (`.skeleton-form` in `styles.css`). The
 * labels are the form's own and the boxes are the form's own, so the loaded
 * form replaces it without a pixel of movement.
 */
export function FormSkeleton({ children }: { children: ReactNode }) {
  return (
    <Waiting>
      <div inert className="skeleton-form">
        {children}
      </div>
    </Waiting>
  );
}
