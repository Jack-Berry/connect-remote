/**
 * Pre-rendered circled-arrow frames for the finder's image indicator.
 *
 * Rasterised phone-side on a canvas at finder entry, encoded as PNG file
 * bytes — the one payload encoding the image spike proved the host accepts
 * (raw 4-bit is rejected with "image format could not be determined";
 * see PROBE-RESULTS-STAGE0.md §G). The cost lands once, on entry; direction
 * changes afterwards are bare `updateImageRawData` pushes.
 *
 * 16 rotation steps are rendered even though today's course quantisation is
 * 8-way (the indicator shows every other frame): the render cost is
 * milliseconds, and a future move to 16-way quantisation becomes a mapping
 * change instead of a pipeline change.
 *
 * Every rotation exists twice — full brightness and DIM — because dim-grey is
 * this build's experimental staleness channel ("this position is hours old").
 * The simulator normalises greys, so whether DIM is legible (or even visibly
 * different) on the panel is exactly what the next hardware walk judges;
 * STALE_DIM_ENABLED in main.ts is the one-line disable if it isn't.
 */

/** 144 is the SDK's image-container height cap — the largest square allowed. */
export const FRAME_SIZE = 144;
export const ROTATION_STEPS = 16;
/** Panel greyscale levels: 15 = full brightness. */
export const LEVEL_BRIGHT = 15;
/** The staleness-channel level under test. */
export const LEVEL_DIM = 5;

export interface ArrowFrames {
  /**
   * PNG bytes for a direction. `octant` is the finder's 8-way index
   * (0 = up, clockwise); null = the ring alone (stationary — a heading the
   * user must look up, not follow). `blank()` is the nothing-to-show frame
   * for problem states.
   */
  get(octant: number | null, dim: boolean): number[];
  blank(): number[];
  renderMs: number;
}

function drawFrame(
  angleDeg: number | null,
  level: number,
  withRing: boolean,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = FRAME_SIZE;
  canvas.height = FRAME_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas context unavailable in this WebView");

  const c = FRAME_SIZE / 2;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, FRAME_SIZE, FRAME_SIZE);

  // The panel is 16 levels of green; drawing in the matching grey means what
  // the phone canvas shows is what the glasses will show.
  const shade = Math.round((level / 15) * 255);
  const ink = `rgb(${shade},${shade},${shade})`;

  if (withRing) {
    ctx.strokeStyle = ink;
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(c, c, c - 6, 0, Math.PI * 2);
    ctx.stroke();
  }

  if (angleDeg != null) {
    ctx.fillStyle = ink;
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate((angleDeg * Math.PI) / 180);
    // Chunky by design: readable at a glance mid-stride, which is the whole
    // complaint about the thin text glyphs. Same geometry the spike showed
    // on the simulator.
    ctx.beginPath();
    ctx.moveTo(0, -44); // tip
    ctx.lineTo(30, 6);
    ctx.lineTo(12, 6);
    ctx.lineTo(12, 44); // stem
    ctx.lineTo(-12, 44);
    ctx.lineTo(-12, 6);
    ctx.lineTo(-30, 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  return canvas;
}

/** PNG file bytes as number[] — the host wants a List<int> it can decode. */
function pngBytes(canvas: HTMLCanvasElement): number[] {
  const b64 = canvas.toDataURL("image/png").split(",")[1];
  const bin = atob(b64);
  const out = new Array<number>(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Render the full set: 16 rotations × {bright, dim}, ring-only × {bright,
 * dim}, and one black frame. ~35 tiny PNGs, done once per finder entry.
 */
export function renderArrowFrames(): ArrowFrames {
  const t0 = performance.now();
  const rotations: number[][][] = [LEVEL_BRIGHT, LEVEL_DIM].map((level) =>
    Array.from({ length: ROTATION_STEPS }, (_, i) =>
      pngBytes(drawFrame((i * 360) / ROTATION_STEPS, level, true)),
    ),
  );
  const rings = [LEVEL_BRIGHT, LEVEL_DIM].map((level) =>
    pngBytes(drawFrame(null, level, true)),
  );
  const black = pngBytes(drawFrame(null, LEVEL_BRIGHT, false));
  const renderMs = Math.round(performance.now() - t0);

  return {
    get(octant, dim) {
      const set = dim ? 1 : 0;
      if (octant == null) return rings[set];
      // 8-way octant onto the 16-step reel: every other frame.
      const idx =
        ((octant * 2) % ROTATION_STEPS + ROTATION_STEPS) % ROTATION_STEPS;
      return rotations[set][idx];
    },
    blank: () => black,
    renderMs,
  };
}
