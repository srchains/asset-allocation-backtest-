import { useState } from "react";
import { ApiError, createAllocation } from "./api";

/** "Save as plan" under the Allocation sliders: stores the current weights as a custom
 *  allocation, so it shows up under Open plan and in the Comparison chart. */
export default function SavePlan({ weights, onSaved }: {
  weights: { NIFTY: number; GOLD: number; BOND: number; CASH: number };
  onSaved?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const w = Object.fromEntries(Object.entries(weights).filter(([, v]) => v > 0));
      const a = await createAllocation(name, w);
      setMsg({ ok: true, text: `Saved "${a.name}". Open it any time with Open plan, or tick it in the Comparison chart.` });
      setName("");
      setOpen(false);
      onSaved?.(a.id);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.errors.join(" ") : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3.5">
      {!open ? (
        <button type="button" onClick={() => { setOpen(true); setMsg(null); }}
          className="w-full rounded-lg border border-accent px-3 py-2 text-sm font-medium text-accent hover:bg-accent/10">
          Save as plan
        </button>
      ) : (
        <div className="rounded-lg border border-border bg-bg p-3">
          <label className="block text-sm text-fg-muted">
            Plan name
            <input autoFocus value={name} maxLength={50} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") save(); }}
              placeholder="My 50/30/15/5"
              className="mt-1 block w-full rounded-lg border border-border bg-panel px-3 py-2 text-base text-fg" />
          </label>
          <div className="mt-2 text-xs text-fg-muted">
            Nifty {weights.NIFTY}% · Gold {weights.GOLD}% · Bonds {weights.BOND}% · Cash {weights.CASH}%
          </div>
          <div className="mt-2.5 flex gap-2">
            <button type="button" onClick={() => setOpen(false)}
              className="flex-1 rounded-lg border border-border px-3 py-1.5 text-sm text-fg-muted hover:text-fg">Cancel</button>
            <button type="button" onClick={save} disabled={busy}
              className="flex-1 rounded-lg border border-accent bg-accent/15 px-3 py-1.5 text-sm font-medium text-accent hover:bg-accent/25 disabled:opacity-50">
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
      {msg && <p className={`mt-2 text-xs ${msg.ok ? "text-bonds" : "text-danger"}`}>{msg.text}</p>}
    </div>
  );
}
