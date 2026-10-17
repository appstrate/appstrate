// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useState } from "react";

/** Latches `true` once the element has come near the viewport, then stops observing. Without `IntersectionObserver` (SSR, tests) the element counts as visible. */
export function useInView<T extends Element>() {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const el = ref.current;
    if (inView || !el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [inView]);
  return [ref, inView] as const;
}
