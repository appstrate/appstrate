// SPDX-License-Identifier: Apache-2.0

import { CopyBlock } from "./copy-block";

interface Props {
  /** The secret value to reveal and copy. */
  secret: string;
  /** Warning banner shown above the secret box. */
  warning: string;
}

/**
 * Display a one-time-revealed secret (API key, webhook secret, ...) with a
 * copy-to-clipboard button. The secret is shown verbatim — callers must only
 * mount this component when they intend to reveal the value.
 */
export function RevealedSecret({ secret, warning }: Props) {
  return (
    <>
      <p className="text-warning bg-warning/10 mb-3 rounded-md px-3 py-2 text-sm">{warning}</p>
      <CopyBlock value={secret} />
    </>
  );
}
