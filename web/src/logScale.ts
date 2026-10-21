/** Axis settings for a log (ratio) scale: the Y axis runs from a round value just below the lowest
 *  point to one just above the highest, with ticks at 1, 2 and 5 x 10^n. Values must be above 0. */
export function logAxis(values: number[]): { domain: [number, number]; ticks: number[] } {
  const v = values.filter((x) => Number.isFinite(x) && x > 0);
  if (!v.length) return { domain: [1, 10], ticks: [1, 10] };
  const min = Math.min(...v), max = Math.max(...v);
  const all: number[] = [];
  for (let e = Math.floor(Math.log10(min)) - 1; e <= Math.ceil(Math.log10(max)) + 1; e++) {
    for (const m of [1, 2, 5]) all.push(m * 10 ** e);
  }
  const lo = Math.max(...all.filter((t) => t <= min));
  const hi = Math.min(...all.filter((t) => t >= max));
  return { domain: [lo, hi], ticks: all.filter((t) => t >= lo && t <= hi) };
}
