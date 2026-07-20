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
  ImageContainerProperty,
  TextContainerProperty,
} from "@evenrealities/even_hub_sdk";

import type { ArrowFrames } from "./arrow-frames";
import {
  FINDER_ARROW_CONTAINER,
  FINDER_ARROW_H,
  FINDER_ARROW_Y,
  FINDER_IMG_CONTAINER,
  FINDER_IMG_SIZE,
  FINDER_IMG_X,
  FINDER_IMG_Y,
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

/** How to show the direction beyond the direction itself. */
export interface IndicatorState {
  /** Draw the ring even with no arrow (stationary: a heading to look up, not
   *  follow). False = problem states — show nothing at all. */
  ring: boolean;
  /** Stale car position — the dim-grey staleness experiment (image only). */
  dim: boolean;
}

export interface DirectionIndicator {
  /** Containers to include when the finder page is built. */
  containers(): DirectionContainers;
  /**
   * Show a quantised 8-way direction, or null for no arrow (stationary,
   * arrived, and every problem state — `state` says which of those looks
   * like what). Must be cheap to call repeatedly with the same value — the
   * finder re-renders once a second.
   */
  update(octant: number | null, state?: IndicatorState): Promise<void>;
  /** Forget what's on screen; called when the page is rebuilt underneath us. */
  reset(): void;
  /** One-off expensive setup (frame pre-render), called at finder entry
   *  before the page is built. Optional: the glyph renderer needs none. */
  prepare?(): void;
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

/**
 * Image renderer — the owner's circled arrow, Round 3.
 *
 * One 144×144 image container, hot-swapped with pre-rendered PNG frames on
 * quantised-direction change (the spike's proven pattern: rebuild once, then
 * bare updateImageRawData pushes, median 4ms in the simulator). The glyph
 * cell is still in the page: BLE flash/reject is formally unverified until
 * this build walks, so the first failed push flips this indicator to driving
 * the glyph container instead — the screen keeps a direction either way, and
 * the failure is logged for the QA sheet.
 *
 * `render` is injected (not imported) so tests can drive the indicator
 * without a canvas, and `pushImage`/`upgrade` so this module stays out of
 * main.ts's bridge serialization chain.
 */
export function createImageIndicator(
  pushImage: (
    ids: { containerID: number; containerName: string },
    imageData: number[],
  ) => Promise<unknown>,
  upgrade: (
    ids: { containerID: number; containerName: string },
    content: string,
  ) => Promise<unknown>,
  render: () => ArrowFrames,
): DirectionIndicator {
  let frames: ArrowFrames | null = null;
  /** Which frame the container holds ("" = blank/unknown, i.e. push). */
  let shownKey = "";
  let glyphShown = "";
  let broken = false;

  return {
    containers() {
      return {
        count: 2,
        textObject: [
          // The fallback glyph cell, vertically centred over the image band.
          // Blank unless a push fails; blank text over a black frame is
          // invisible, so carrying both costs nothing.
          new TextContainerProperty({
            xPosition: 0,
            yPosition: FINDER_IMG_Y + 36,
            width: 576,
            height: FINDER_ARROW_H,
            borderWidth: 0,
            borderColor: 0,
            paddingLength: 4,
            ...FINDER_ARROW_CONTAINER,
            content: " ",
            isEventCapture: 0,
          }),
        ],
        imageObject: [
          new ImageContainerProperty({
            xPosition: FINDER_IMG_X,
            yPosition: FINDER_IMG_Y,
            width: FINDER_IMG_SIZE,
            height: FINDER_IMG_SIZE,
            ...FINDER_IMG_CONTAINER,
          }),
        ],
      };
    },

    prepare() {
      if (frames || broken) return;
      try {
        frames = render();
        console.log(`finder: arrow frames rendered in ${frames.renderMs}ms`);
      } catch (err) {
        // No canvas (or PNG encode failed): the glyph path needs neither.
        broken = true;
        console.log(`finder: arrow frame render FAILED, glyph fallback: ${err}`);
      }
    },

    async update(octant, state = { ring: true, dim: false }) {
      if (!frames && !broken) return; // prepare() not run — nothing to push yet
      const showRing = state.ring || octant != null;
      const key = showRing
        ? `${octant ?? "ring"}/${state.dim ? "dim" : "bright"}`
        : "blank";
      if (key === shownKey && !broken) return;

      if (!broken && frames) {
        const data = showRing ? frames.get(octant, state.dim) : frames.blank();
        try {
          await pushImage(FINDER_IMG_CONTAINER, data);
          shownKey = key;
          return;
        } catch (err) {
          // Host rejected the push (the unverified-over-BLE case). Fall back
          // to the glyph for the rest of the session — and say so loudly:
          // this line is the QA answer to "does the image path work on
          // hardware".
          broken = true;
          console.log(`finder: image push FAILED, glyph fallback on: ${err}`);
        }
      }

      const glyph = arrowCell(octant == null ? null : ARROWS[octant]);
      if (glyph === glyphShown) return;
      glyphShown = glyph;
      await upgrade(FINDER_ARROW_CONTAINER, glyph);
    },

    reset() {
      // Page rebuilt underneath us: the image container is blank again and
      // frames must be re-pushed. The pre-rendered frames themselves survive
      // (rendering is per-app-run, not per-entry).
      shownKey = "";
      glyphShown = "";
    },
  };
}
