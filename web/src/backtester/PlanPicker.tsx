import { useEffect, useRef, useState } from "react";
import type { Allocation, AssetConfig } from "./api";
import { weightsText } from "./format";

/** Allocation picker with a checkbox per plan (grouped Predefined / Custom). Each plan shows the
 *  colour it gets in the comparison chart. */
export default function PlanPicker({ assets, allocations, selected, colorOf, onChange }: {
  assets: Record<string, AssetConfig>;
  allocations: Allocation[];
  selected: string[];
  colorOf: (id: string) => string;
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);

  // keep the list order (not the click order) so colours and rows stay put
  const toggle = (id: string) =>
    onChange(selected.includes(id)
      ? selected.filter((x) => x !== id)
      : allocations.map((a) => a.id).filter((x) => x === id || selected.includes(x)));

  const chosen = allocations.filter((a) => selected.includes(a.id));
  const summary = chosen.length === 0 ? "Pick one or more plans"
    : chosen.length === 1 ? `${chosen[0].name} — ${weightsText(assets, chosen[0].weights)}`
    : `${chosen.length} plans to compare: ${chosen.map((a) => a.name).join(", ")}`;
  const groups: [string, Allocation[]][] = [
    ["Predefined", allocations.filter((a) => a.type === "predefined")],
    ["Custom", allocations.filter((a) => a.type === "custom")],
  ];

  return (
    <div ref={box} className="relative mt-1">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2 text-left text-base text-fg">
        <span className="flex shrink-0 -space-x-1">
          {chosen.slice(0, 5).map((a) => (
            <span key={a.id} className="h-3 w-3 rounded-full ring-2 ring-bg" style={{ background: colorOf(a.id) }} />
          ))}
        </span>
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        <svg className={`h-4 w-4 shrink-0 text-fg-muted transition-transform ${open ? "rotate-180" : ""}`} viewBox="0 0 20 20" fill="currentColor">
          <path d="M5.3 7.3a1 1 0 0 1 1.4 0L10 10.6l3.3-3.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 0-1.4z" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 right-0 z-30 mt-1 max-h-[420px] overflow-y-auto rounded-lg border border-border bg-panel py-1 shadow-xl">
          <div className="flex items-center justify-between px-3 py-1.5 text-xs text-fg-muted">
            <span>Tick plans to compare ({selected.length} selected)</span>
            {selected.length > 0 && (
              <button type="button" className="text-accent hover:underline" onClick={() => onChange([])}>Clear</button>
            )}
          </div>
          {groups.map(([g, list]) => list.length > 0 && (
            <div key={g}>
              <div className="px-3 pb-1 pt-2 text-sm font-semibold text-fg">{g}</div>
              {list.map((a) => {
                const on = selected.includes(a.id);
                return (
                  <label key={a.id} className={`flex cursor-pointer items-center gap-2.5 px-3 py-1.5 text-sm hover:bg-bg ${on ? "text-fg" : "text-fg-muted"}`}>
                    <input type="checkbox" checked={on} onChange={() => toggle(a.id)} className="h-4 w-4 shrink-0 accent-[var(--color-accent)]" />
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colorOf(a.id) }} />
                    <span className="min-w-0 flex-1 truncate">
                      <span className={on ? "font-medium" : ""}>{a.name}</span> — {weightsText(assets, a.weights)}
                    </span>
                  </label>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
