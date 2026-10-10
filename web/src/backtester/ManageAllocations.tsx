import { useRef, useState } from "react";
import {
  ApiError, createAllocation, deleteAllocation, duplicateAllocation, exportAllocations, importAllocations, updateAllocation,
  type Allocation, type AssetConfig, type ImportSummary,
} from "./api";
import { ErrorBox } from "./ui";
import { weightsText } from "./format";

type Assets = Record<string, AssetConfig>;


const btn = "rounded-lg border border-border bg-bg px-3 py-1.5 text-sm text-fg-muted hover:text-fg";
const btnAccent = "rounded-lg border border-accent px-3 py-1.5 text-sm font-medium text-accent hover:bg-accent/10";

function AllocationForm({ assets, initial, onSave, onCancel }: {
  assets: Assets;
  initial?: Allocation;
  onSave: (name: string, weights: Record<string, number>) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [w, setW] = useState<Record<string, string>>(
    Object.fromEntries(Object.keys(assets).map((a) => [a, String(initial?.weights[a] ?? "")]))
  );
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const total = Object.values(w).reduce((s, v) => s + (Number(v) || 0), 0);
  const ok = Math.abs(total - 100) <= 0.01;

  const save = async () => {
    const weights = Object.fromEntries(Object.entries(w).filter(([, v]) => v.trim() !== "").map(([a, v]) => [a, Number(v)]));
    setBusy(true);
    try {
      await onSave(name, weights);
    } catch (e) {
      setErrors(e instanceof ApiError ? e.errors : [String(e)]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-4 rounded-lg border border-accent/50 bg-bg p-4">
      <div className="mb-3 text-base font-semibold text-fg">{initial ? `Edit "${initial.name}"` : "New allocation"}</div>
      <ErrorBox errors={errors} />
      <label className="mb-3 block text-sm text-fg-muted">
        Name
        <input value={name} maxLength={50} onChange={(e) => { setName(e.target.value); setErrors([]); }}
          className="mt-1 block w-full rounded-lg border border-border bg-panel px-3 py-2 text-base text-fg" placeholder="My growth mix" />
      </label>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Object.entries(assets).map(([a, cfg]) => (
          <label key={a} className="block text-sm text-fg-muted">
            <span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-sm" style={{ background: cfg.color ?? "#888" }} />
            {cfg.label} %
            <input type="number" min={0} max={100} step={0.01} value={w[a]}
              onChange={(e) => { setW({ ...w, [a]: e.target.value }); setErrors([]); }}
              className="mt-1 block w-full rounded-lg border border-border bg-panel px-3 py-2 text-base tabular-nums text-fg" placeholder="0" />
          </label>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <span className={`text-sm font-medium tabular-nums ${ok ? "text-bonds" : "text-danger"}`}>
          Total {Number(total.toFixed(2))}% {ok ? "" : `(needs to be 100)`}
        </span>
        <div className="flex gap-2">
          <button type="button" className={btn} onClick={onCancel}>Cancel</button>
          <button type="button" className={btnAccent} disabled={busy} onClick={save}>{busy ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </div>
  );
}

export default function ManageAllocations({ assets, allocations, onChanged, onClose }: {
  assets: Assets;
  allocations: Allocation[];
  onChanged: (selectId?: string) => Promise<void>;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<{ kind: "new" } | { kind: "edit"; alloc: Allocation } | null>(null);
  const [dup, setDup] = useState<{ id: string; name: string } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const guard = async (f: () => Promise<void>) => {
    setErrors([]);
    try {
      await f();
    } catch (e) {
      setErrors(e instanceof ApiError ? e.errors : [String(e)]);
    }
  };

  const doExport = () => guard(async () => {
    const doc = await exportAllocations();
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "asset_allocations_export.json";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  const doImport = (file: File) => guard(async () => {
    let doc: unknown;
    try {
      doc = JSON.parse(await file.text());
    } catch {
      throw new ApiError(`${file.name} is not valid JSON.`);
    }
    const s = await importAllocations(doc);
    setSummary(s);
    await onChanged();
  });

  const groups: [string, Allocation[]][] = [
    ["Predefined", allocations.filter((a) => a.type === "predefined")],
    ["Custom", allocations.filter((a) => a.type === "custom")],
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-12" onClick={onClose}>
      <div className="w-full max-w-4xl rounded-xl border border-border bg-panel p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold text-fg">Manage allocations</h2>
          <button type="button" aria-label="Close" className="rounded-lg px-2 text-2xl leading-none text-fg-muted hover:text-fg" onClick={onClose}>×</button>
        </div>

        <div className="mb-4 flex flex-wrap gap-2">
          <button type="button" className={btnAccent} onClick={() => { setMode({ kind: "new" }); setSummary(null); }}>+ New allocation</button>
          <button type="button" className={btn} onClick={doExport}>Export JSON</button>
          <button type="button" className={btn} onClick={() => fileRef.current?.click()}>Import JSON</button>
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) doImport(f); e.target.value = ""; }} />
        </div>

        <ErrorBox errors={errors} />

        {summary && (
          <div className="mb-4 rounded-lg border border-border bg-bg px-4 py-3 text-sm">
            <div className="mb-1 font-semibold text-fg">
              Import: {summary.imported.length} added, {summary.skipped.length} skipped, {summary.failed.length} failed
            </div>
            {summary.imported.length > 0 && <div className="text-bonds">Added: {summary.imported.map((a) => a.name).join(", ")}</div>}
            {summary.skipped.length > 0 && (
              <div className="text-fg-muted">Skipped: {summary.skipped.map((s) => `${s.name} (${s.reason})`).join("; ")}</div>
            )}
            {summary.failed.map((f) => <div key={f.name} className="text-danger">{f.name}: {f.errors.join("; ")}</div>)}
          </div>
        )}

        {mode && (
          <AllocationForm key={mode.kind === "edit" ? mode.alloc.id : "new"} assets={assets}
            initial={mode.kind === "edit" ? mode.alloc : undefined}
            onCancel={() => setMode(null)}
            onSave={async (name, weights) => {
              const saved = mode.kind === "edit"
                ? await updateAllocation(mode.alloc.id, name, weights)
                : await createAllocation(name, weights);
              setMode(null);
              await onChanged(saved.id);
            }} />
        )}

        {groups.map(([title, list]) => (
          <div key={title} className="mb-4">
            <div className="mb-2 text-sm font-semibold uppercase tracking-wide text-fg-muted">{title}</div>
            {list.length === 0 && <p className="text-sm text-fg-muted">No custom allocations yet. Create one or duplicate a predefined one.</p>}
            <div className="divide-y divide-border rounded-lg border border-border">
              {list.map((a) => (
                <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                  <div>
                    <div className="text-base text-fg">{a.name}</div>
                    <div className="text-sm text-fg-muted">{weightsText(assets, a.weights)}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {dup?.id === a.id ? (
                      <>
                        <input autoFocus value={dup.name} maxLength={50} onChange={(e) => setDup({ ...dup, name: e.target.value })}
                          className="w-52 rounded-lg border border-border bg-bg px-2.5 py-1.5 text-sm text-fg" />
                        <button type="button" className={btnAccent} onClick={() => guard(async () => {
                          const c = await duplicateAllocation(a.id, dup.name);
                          setDup(null);
                          await onChanged(c.id);
                        })}>Save copy</button>
                        <button type="button" className={btn} onClick={() => setDup(null)}>Cancel</button>
                      </>
                    ) : (
                      <button type="button" className={btn} onClick={() => setDup({ id: a.id, name: `${a.name} (copy)`.slice(0, 50) })}>Duplicate</button>
                    )}
                    {a.type === "custom" && (
                      <>
                        <button type="button" className={btn} onClick={() => { setMode({ kind: "edit", alloc: a }); setSummary(null); }}>Edit</button>
                        <button type="button" className={`${btn} hover:!text-danger`} onClick={() => {
                          if (window.confirm(`Delete "${a.name}"? This cannot be undone.`))
                            guard(async () => { await deleteAllocation(a.id); await onChanged(); });
                        }}>Delete</button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
