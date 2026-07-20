/**
 * The finder's direction indicator, behind a swappable interface.
 *
 * Stage 1 ships the glyph renderer: one arrow character in a text container.
 * It is cheap, needs no new platform capability, and both candidate glyph sets
 * are confirmed present in the firmware font on real hardware.
 *
 * The owner wants a proper graphic instead — a large arrow in a circle, around
 * 144x144, which means an image container and `updateImageRawData`. Whether
 * that can hot-swap its pixels without a page rebuild and without a visible
 * flash is unverified (see sensor-probe's image spike). So the indicator is
 * isolated here: a second implementation drops in behind this interface, and
 * the glyph renderer stays as the fallback either way.
 *
 * What an image implementation would replace:
 *   containers() → an ImageContainerProperty instead of a TextContainerProperty
 *                  (the SDK caps image height at 144, so 144x144 is the
 *                  largest square available — exactly the size wanted)
 *   update()     → bridge.updateImageRawData with a pre-rendered frame
 *                  instead of a text upgrade
 * Nothing else in the finder changes: main.ts asks for containers, then calls
 * update() with a quantised direction, and knows nothing about how it's drawn.
 */

import {
  type ImageContainerProperty,
  TextContainerProperty,
} from "@evenrealities/even_hub_sdk";

import {
  FINDER_ARROW_CONTAINER,
  FINDER_ARROW_H,
  FINDER_ARROW_Y,
  arrowCell,
} from "./display";
import { ARROWS } from "./finder";

/** What the indicator contributes to the finder page build. */
export interface DirectionContainers {
  /** How many containers this adds to containerTotalNum. */
  count: number;
  textObject: TextContainerProperty[];
  /** An image-container implementation would populate this instead. */
  imageObject?: ImageContainerProperty[];
}

export interface DirectionIndicator {
  /** Containers to include when the finder page is built. */
  containers(): DirectionContainers;
  /**
   * Show a quantised 8-way direction, or null to show nothing (stationary,
   * arrived, and every problem state). Must be cheap to call repeatedly with
   * the same value — the finder re-renders once a second.
   */
  update(octant: number | null): Promise<void>;
  /** Forget what's on screen; called when the page is rebuilt underneath us. */
  reset(): void;
}

/** Content the indicator's container should hold at page-build time. */
export function initialDirectionContent(octant: number | null): string {
  return arrowCell(octant == null ? null : ARROWS[octant]);
}

/**
 * Glyph renderer — Stage 1's shipping implementation and the permanent
 * fallback. `upgrade` is injected rather than imported so this module doesn't
 * reach back into main.ts's bridge serialization chain.
 */
export function createGlyphIndicator(
  upgrade: (
    ids: { containerID: number; containerName: string },
    content: string,
  ) => Promise<unknown>,
  initialOctant: number | null = null,
): DirectionIndicator {
  let shown = initialDirectionContent(initialOctant);

  return {
    containers() {
      return {
        count: 1,
        textObject: [
          new TextContainerProperty({
            xPosition: 0,
            yPosition: FINDER_ARROW_Y,
            width: 576,
            height: FINDER_ARROW_H,
            borderWidth: 0,
            borderColor: 0,
            paddingLength: 4,
            ...FINDER_ARROW_CONTAINER,
            content: shown,
            isEventCapture: 0,
          }),
        ],
      };
    },

    async update(octant) {
      const next = initialDirectionContent(octant);
      // Skip the no-op: the finder ticks once a second and the direction
      // changes every few seconds at most, so most calls change nothing.
      if (next === shown) return;
      shown = next;
      await upgrade(FINDER_ARROW_CONTAINER, next);
    },

    reset() {
      shown = initialDirectionContent(null);
    },
  };
}
