// SPDX-License-Identifier: Apache-2.0

/**
 * The Appstrate mark: brackets plus the bolt, no wordmark.
 *
 * Inlined rather than shipped as a file in `public/` so the brackets can follow
 * `currentColor` — the source asset hard-codes them to #1a1a1a, which vanishes
 * on a dark surface. The bolt keeps its own gradient in both themes.
 */
export function AppstrateMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 828.63 1020" className={className} aria-hidden focusable="false">
      <defs>
        <linearGradient
          id="appstrate-bolt"
          x1="226"
          y1="240"
          x2="600"
          y2="800"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#ff7e27" />
          <stop offset="0.5" stopColor="#e55342" />
          <stop offset="1" stopColor="#ce2e59" />
        </linearGradient>
      </defs>
      <path
        fill="currentColor"
        d="M20 191.25C8.95 191.25 0 200.2 0 211.25L0 809.28C0 820.33 8.95 829.28 20 829.28L236.5 829.28C247.55 829.28 256.5 820.33 256.5 809.28L256.5 780.78C256.5 769.74 247.55 760.78 236.5 760.78L68.5 760.78L68.5 259.75L236.5 259.75C247.55 259.75 256.5 250.8 256.5 239.75L256.5 211.25C256.5 200.2 247.55 191.25 236.5 191.25L20 191.25Z"
      />
      <path
        fill="currentColor"
        d="M808.63 829.02C819.68 829.02 828.63 820.06 828.63 809.02L828.63 210.98C828.63 199.94 819.68 190.98 808.63 190.98L592.13 190.98C581.08 190.98 572.13 199.94 572.13 210.98L572.13 239.48C572.13 250.53 581.08 259.48 592.13 259.48L760.13 259.48L760.13 760.52L592.13 760.52C581.08 760.52 572.13 769.47 572.13 780.52L572.13 809.02C572.13 820.06 581.08 829.02 592.13 829.02L808.63 829.02Z"
      />
      <path
        fill="url(#appstrate-bolt)"
        d="M494.66 235.49C497.95 215.24 472.24 203.76 459.35 219.73L211.08 527.53C200.53 540.61 209.84 560.08 226.65 560.08L346.21 560.08C358.54 560.08 367.93 571.12 365.96 583.28L332.68 788.51C329.4 808.77 355.11 820.24 367.99 804.27L616.26 496.48C626.82 483.39 617.5 463.92 600.7 463.92L481.13 463.92C468.81 463.92 459.42 452.88 461.39 440.72L494.66 235.49Z"
      />
    </svg>
  );
}
