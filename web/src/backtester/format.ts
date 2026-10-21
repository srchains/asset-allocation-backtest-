// Formatting helpers and constants shared by the backtester pages.
import type { AssetConfig } from "./api";

export const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
export const pct = (n: number, d = 2) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`;
export const num2 = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const lakh = (n: number) =>
  n >= 1e7 ? `₹${(n / 1e7).toFixed(1)}Cr` : n >= 1e5 ? `₹${(n / 1e5).toFixed(1)}L` : `₹${Math.round(n / 1000)}k`;

export const tooltipStyle = {
  background: "var(--color-panel)",
  border: "1px solid var(--color-grid)",
  borderRadius: 8,
  fontSize: 13,
};

/** Every n-th point (always keeping the last) so long daily series stay fast in the charts. */
export function thin<T>(rows: T[], max = 1200): T[] {
  if (rows.length <= max) return rows;
  const step = Math.ceil(rows.length / max);
  const out = rows.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== rows[rows.length - 1]) out.push(rows[rows.length - 1]);
  return out;
}

export const fmtDate = (d: string) =>
  new Date(d + "T00:00:00").toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

/** Fall from the previous high, in % (0 = at a new high). */
export function drawdowns(values: number[]): number[] {
  let peak = -Infinity;
  return values.map((v) => { peak = Math.max(peak, v); return peak > 0 ? (v / peak - 1) * 100 : 0; });
}

export const th = "whitespace-nowrap px-3 py-2.5 font-semibold";
export const td = "whitespace-nowrap px-3 py-2 tabular-nums";

export function weightsText(assets: Record<string, AssetConfig>, w: Record<string, number>) {
  return Object.entries(w).map(([a, v]) => `${assets[a]?.label ?? a}: ${v}%`).join(" · ");
}
