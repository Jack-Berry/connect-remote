/**
 * Image-container spike — the arrow-as-graphic question.
 *
 * The finder's direction indicator currently draws one arrow *character* in a
 * text container. The owner wants a proper graphic: a large arrow inside a
 * circle, ~144x144 (which is exactly the SDK's maximum image-container height,
 * so it is the biggest square the platform allows). That means an image
 * container and `updateImageRawData`, and hinges on one thing nobody has
 * measured: **can an image container's pixels be replaced without a
 * rebuildPageContainer, and without a visible flash?**
 *
 * G2-CAPABILITIES lists image update throughput and hot-swap behaviour as
 * unmeasured. This answers it permanently — for the finder, and for the
 * sprite/arcade-game question that hangs off the same capability.
 *
 * ## The encoding question came first
 *
 * G2-CAPABILITIES §4 describes `updateImageRawData` as taking "raw 4-bit
 * greyscale pixel data". The SDK's own docs only ever say "image data". The
 * first simulator run of this spike rejected 10368 bytes of packed 4-bit
 * samples with:
 *
 *     update_image_raw_data: failed to decode image:
 *     The image format could not be determined
 *
 * — i.e. the host is running the bytes through an image *decoder*, so it wants
 * an encoded file (PNG and friends), not a pixel array. That may or may not
 * also be true of the real firmware, so all four candidates stay switchable at
 * runtime and the spike reports which ones the host accepts. Whichever draws a
 * recognisable arrow is the answer, and it is worth as much as the timing
 * numbers.
 */

export const FRAME_SIZE = 144;

/** Greyscale level for a "bright" frame — 15 is full brightness. */
export const LEVEL_BRIGHT = 15;
/**
 * A dim level. The owner may want dimness as a staleness channel ("this
 * position is hours old"), so the spike renders one frame this way to settle
 * whether dim greys are legible enough on the panel to bother with.
 */
export const LEVEL_DIM = 5;

// ---------------------------------------------------------------------------
// Drawing
//
// Rasterised phone-side on a canvas. This is exactly what the finder would do
// at first run for its 16 rotations — the cost lands once, on entry, not per
// direction change.

/**
 * A circled arrow pointing `angleDeg` clockwise from straight up, drawn at
 * `level`/15 brightness on a black field.
 */
export function drawCircledArrow(angleDeg: number, level: number): HTMLCanvasElement {
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
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(c, c, c - 6, 0, Math.PI * 2);
  ctx.stroke();

  ctx.save();
  ctx.translate(c, c);
  ctx.rotate((angleDeg * Math.PI) / 180);
  // Chunky by design: this is meant to be readable at a glance, mid-stride,
  // which is the whole complaint about the thin text glyphs.
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

  return canvas;
}

/** 4-bit samples (0–15), row-major, from a drawn canvas. */
export function quantise(canvas: HTMLCanvasElement): Uint8Array {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas context unavailable");
  const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const samples = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0; i < samples.length; i++) {
    // Drawn in greys, so any channel is the luminance.
    samples[i] = Math.round((px[i * 4] / 255) * 15);
  }
  return samples;
}

// ---------------------------------------------------------------------------
// Candidate payload encodings

export type EncodingId = "png" | "png-b64" | "packed4" | "byte";

export interface Encoding {
  id: EncodingId;
  label: string;
  build(canvas: HTMLCanvasElement): number[] | string;
}

function pngBytes(canvas: HTMLCanvasElement): number[] {
  const b64 = canvas.toDataURL("image/png").split(",")[1];
  const bin = atob(b64);
  const out = new Array<number>(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const ENCODINGS: Encoding[] = [
  {
    id: "png",
    label: "PNG file bytes (number[])",
    build: pngBytes,
  },
  {
    id: "png-b64",
    label: "PNG as base64 string (the SDK says it accepts one)",
    build: (canvas) => canvas.toDataURL("image/png").split(",")[1],
  },
  {
    id: "packed4",
    label: "raw 4-bit packed (2px/byte, high nibble first)",
    build(canvas) {
      const s = quantise(canvas);
      const out: number[] = [];
      for (let i = 0; i < s.length; i += 2) {
        out.push(((s[i] & 0x0f) << 4) | (s[i + 1] & 0x0f));
      }
      return out;
    },
  },
  {
    id: "byte",
    label: "raw, one byte per pixel (value 0-15)",
    build: (canvas) => Array.from(quantise(canvas)),
  },
];

// ---------------------------------------------------------------------------
// Frames

export interface Frame {
  label: string;
  angle: number;
  level: number;
  canvas: HTMLCanvasElement;
}

/** The spike's reel: three rotations bright, plus the same arrow dim. */
export function buildFrames(): Frame[] {
  const frames: Frame[] = [0, 90, 180].map((angle) => ({
    label: `${angle}° bright(${LEVEL_BRIGHT})`,
    angle,
    level: LEVEL_BRIGHT,
    canvas: drawCircledArrow(angle, LEVEL_BRIGHT),
  }));
  frames.push({
    label: `0° DIM(${LEVEL_DIM})`,
    angle: 0,
    level: LEVEL_DIM,
    canvas: drawCircledArrow(0, LEVEL_DIM),
  });
  return frames;
}

// ---------------------------------------------------------------------------
// Timing

export interface PushResult {
  ms: number;
  size: number;
  ok: boolean;
  detail: string;
}

/** Rolling stats over the pushes so far — what gets reported back. */
export class PushStats {
  private samples: number[] = [];
  failures = 0;

  add(r: PushResult): void {
    if (r.ok) this.samples.push(r.ms);
    else this.failures++;
  }

  get count(): number {
    return this.samples.length;
  }

  reset(): void {
    this.samples = [];
    this.failures = 0;
  }

  summary(): string {
    if (!this.samples.length) {
      return `no successful pushes (${this.failures} failed)`;
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    const mean = Math.round(
      this.samples.reduce((a, b) => a + b, 0) / this.samples.length,
    );
    return `n=${this.samples.length} min ${sorted[0]} med ${
      sorted[Math.floor(sorted.length / 2)]
    } mean ${mean} max ${sorted[sorted.length - 1]} ms${
      this.failures ? ` · ${this.failures} failed` : ""
    }`;
  }
}
