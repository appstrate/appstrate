// SPDX-License-Identifier: Apache-2.0

import * as React from "react";
import useEmblaCarousel from "embla-carousel-react";
import { WheelGesturesPlugin } from "embla-carousel-wheel-gestures";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "../cn.ts";
import { Button } from "./button.tsx";
import { CarouselContext, useCarousel, type CarouselApi } from "./carousel-context.ts";
import { useUiLabels } from "./ui-labels.ts";

type UseCarouselParameters = Parameters<typeof useEmblaCarousel>;
type CarouselOptions = UseCarouselParameters[0];
type CarouselPlugin = UseCarouselParameters[1];

type CarouselProps = {
  opts?: CarouselOptions;
  plugins?: CarouselPlugin;
  orientation?: "horizontal" | "vertical";
  setApi?: (api: CarouselApi) => void;
};

/** Scroll progress (0–1) under which the track counts as resting on an edge. */
const SCROLL_EDGE = 0.005;

/**
 * Stock shadcn carousel, plus Embla's wheel-gestures plugin: a trackpad swipe
 * (or shift+wheel) along the carousel's axis scrolls it, as a native overflow
 * would. A wheel along the other axis is left to the page.
 */
function Carousel({
  orientation = "horizontal",
  opts,
  setApi,
  plugins,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & CarouselProps) {
  const [carouselRef, api] = useEmblaCarousel(
    { ...opts, axis: orientation === "horizontal" ? "x" : "y" },
    [WheelGesturesPlugin(), ...(plugins ?? [])],
  );
  // Embla is the store. `canScroll*` follows the selected snap, which under
  // `dragFree` can sit at the start while the track rests between snaps, so
  // the scroll progress answers too (NaN when nothing overflows: false).
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      if (!api) return () => {};
      api.on("reInit", onChange).on("select", onChange).on("scroll", onChange);
      return () => {
        api.off("reInit", onChange).off("select", onChange).off("scroll", onChange);
      };
    },
    [api],
  );
  const canScrollPrev = React.useSyncExternalStore(
    subscribe,
    () => !!api && (api.canScrollPrev() || api.scrollProgress() > SCROLL_EDGE),
    () => false,
  );
  const canScrollNext = React.useSyncExternalStore(
    subscribe,
    () => !!api && (api.canScrollNext() || api.scrollProgress() < 1 - SCROLL_EDGE),
    () => false,
  );

  const scrollPrev = React.useCallback(() => api?.scrollPrev(), [api]);
  const scrollNext = React.useCallback(() => api?.scrollNext(), [api]);

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        scrollPrev();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        scrollNext();
      }
    },
    [scrollPrev, scrollNext],
  );

  React.useEffect(() => {
    if (!api || !setApi) return;
    setApi(api);
  }, [api, setApi]);

  const context = React.useMemo(
    () => ({
      carouselRef,
      api,
      orientation,
      scrollPrev,
      scrollNext,
      canScrollPrev,
      canScrollNext,
    }),
    [carouselRef, api, orientation, scrollPrev, scrollNext, canScrollPrev, canScrollNext],
  );

  return (
    <CarouselContext.Provider value={context}>
      <div
        onKeyDownCapture={handleKeyDown}
        className={cn("relative", className)}
        role="region"
        aria-roledescription="carousel"
        data-slot="carousel"
        {...props}
      >
        {children}
      </div>
    </CarouselContext.Provider>
  );
}

function CarouselContent({ className, ...props }: React.ComponentProps<"div">) {
  const { carouselRef, orientation } = useCarousel();

  return (
    <div ref={carouselRef} className="overflow-hidden" data-slot="carousel-content">
      <div
        className={cn("flex", orientation === "horizontal" ? "-ml-4" : "-mt-4 flex-col", className)}
        {...props}
      />
    </div>
  );
}

function CarouselItem({ className, ...props }: React.ComponentProps<"div">) {
  const { orientation } = useCarousel();

  return (
    <div
      role="group"
      aria-roledescription="slide"
      data-slot="carousel-item"
      className={cn(
        "min-w-0 shrink-0 grow-0 basis-full",
        orientation === "horizontal" ? "pl-4" : "pt-4",
        className,
      )}
      {...props}
    />
  );
}

function CarouselPrevious({
  className,
  variant = "outline",
  size = "icon",
  ...props
}: React.ComponentProps<typeof Button>) {
  const { orientation, scrollPrev, canScrollPrev } = useCarousel();
  const labels = useUiLabels();

  return (
    <Button
      data-slot="carousel-previous"
      variant={variant}
      size={size}
      className={cn(
        "absolute size-8 rounded-full",
        orientation === "horizontal"
          ? "top-1/2 -left-12 -translate-y-1/2"
          : "-top-12 left-1/2 -translate-x-1/2 rotate-90",
        className,
      )}
      disabled={!canScrollPrev}
      onClick={scrollPrev}
      {...props}
    >
      <ChevronLeft />
      <span className="sr-only">{labels.carouselPrevious}</span>
    </Button>
  );
}

function CarouselNext({
  className,
  variant = "outline",
  size = "icon",
  ...props
}: React.ComponentProps<typeof Button>) {
  const { orientation, scrollNext, canScrollNext } = useCarousel();
  const labels = useUiLabels();

  return (
    <Button
      data-slot="carousel-next"
      variant={variant}
      size={size}
      className={cn(
        "absolute size-8 rounded-full",
        orientation === "horizontal"
          ? "top-1/2 -right-12 -translate-y-1/2"
          : "-bottom-12 left-1/2 -translate-x-1/2 rotate-90",
        className,
      )}
      disabled={!canScrollNext}
      onClick={scrollNext}
      {...props}
    >
      <ChevronRight />
      <span className="sr-only">{labels.carouselNext}</span>
    </Button>
  );
}

export { Carousel, CarouselContent, CarouselItem, CarouselPrevious, CarouselNext };
