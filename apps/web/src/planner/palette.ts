/**
 * Every colour on screen is derived from the member palette.
 *
 * A person's colour is assigned once at join and never changes, so it is the
 * one thing in this product that reliably identifies someone across the chat,
 * the calendar and the map. Rather than introduce a brand colour to compete
 * with it, each surface is mixed from the person's own hex.
 */
function channels(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ];
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}`;
}

function mix(hex: string, towards: string, amount: number): string {
  const from = channels(hex);
  const to = channels(towards);
  return toHex([
    from[0] + (to[0] - from[0]) * amount,
    from[1] + (to[1] - from[1]) * amount,
    from[2] + (to[2] - from[2]) * amount,
  ]);
}

export const INK = '#1B1A20';
const PAPER = '#FFFFFF';

/** The pastel an event block is filled with. */
export function fill(hex: string): string {
  return mix(hex, PAPER, 0.92);
}

/** A slightly stronger wash, for the block a warning concerns. */
export function edge(hex: string): string {
  return mix(hex, PAPER, 0.68);
}

/** Readable on `fill`: used for the time line inside a block. */
export function onFill(hex: string): string {
  return mix(hex, INK, 0.32);
}

/** Quieter still, for a venue line under a title. */
export function onFillMuted(hex: string): string {
  return mix(mix(hex, INK, 0.18), PAPER, 0.42);
}

/** The bubble behind somebody's own message. */
export function bubble(hex: string): string {
  return mix(hex, PAPER, 0.86);
}
