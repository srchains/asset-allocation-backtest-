import { useEffect, useState } from "react";
import { ApiError, deleteAllocation, listAllocations, type Allocation, type AssetConfig } from "./api";
import { ErrorBox } from "./ui";

/** Saved plans tab: your custom allocations (saved from the Asset Allocation page or the
 *  Backtester), with their weights and buttons to use them. */
export default function SavedPlansPage({ onLoad, onBacktest }: {
  onLoad: (weights: Record<string, number>) => void;
  onBacktest: (id: string) => void;
}) {
  const [assets, setAssets] = useState<Record<string, AssetConfig>>({});
  const [plans, setPlans] = useState<Allocation[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const reload = () =>
    listAllocations()
      .then((d) => { setAssets(d.assets); setPlans(d.allocations.filter((a) => a.type === "custom")); })
      .catch((e) => setErrors(e instanceof ApiError ? e.errors : [String(e)]));

  useEffect(() => { reload(); }, []);

  const fmt = (s?: string) => (s ? new Date(s).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—");
  const btn = "rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-fg-muted hover:text-fg";

  return (
    <div>
      <p className="mb-4 text-sm text-fg-muted">
        Plans you saved with <strong className="text-fg">Save as plan</strong> on the Asset Allocation page (or created in the
        Backtester). Load one back into the sliders, or run it in the Backtester.
      </p>
      <ErrorBox errors={errors} />
      {plans === null && !errors.length && <p className="py-8 text-center text-fg-muted">Loading plans…</p>}
      {plans?.length === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-panel p-8 text-center text-fg-muted">
          No saved plans yet. Set the sliders on the Asset Allocation tab and press <strong className="text-fg">Save as plan</strong>.
        </div>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        {plans?.map((p) => (
          <section key={p.id} className="rounded-xl border border-border bg-panel p-4">
            <div className="mb-2 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold text-fg">{p.name}</h3>
                <div className="text-xs text-fg-muted">Saved {fmt(p.created_at)}{p.updated_at && p.updated_at !== p.created_at ? ` · changed ${fmt(p.updated_at)}` : ""}</div>
              </div>
            </div>
            <div className="mb-2 flex h-3 overflow-hidden rounded-full">
              {Object.entries(p.weights).map(([a, w]) => (
                <div key={a} style={{ width: `${w}%`, background: assets[a]?.color ?? "#888" }} title={`${assets[a]?.label ?? a} ${w}%`} />
              ))}
            </div>
            <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {Object.entries(p.weights).map(([a, w]) => (
                <span key={a} className="flex items-center gap-1.5">
                  <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: assets[a]?.color ?? "#888" }} />
                  <span className="text-fg-muted">{assets[a]?.label ?? a}</span>
                  <strong className="tabular-nums text-fg">{w}%</strong>
                </span>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={btn} onClick={() => onLoad(p.weights)}>Load in Asset Allocation</button>
              <button type="button" className="rounded-lg border border-accent px-3 py-1.5 text-sm font-medium text-accent hover:bg-accent/10"
                onClick={() => onBacktest(p.id)}>Open in Backtester</button>
              <button type="button" className={`${btn} hover:!text-danger`} onClick={() => {
                if (window.confirm(`Delete "${p.name}"? This cannot be undone.`))
                  deleteAllocation(p.id).then(reload).catch((e) => setErrors(e instanceof ApiError ? e.errors : [String(e)]));
              }}>Delete</button>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
