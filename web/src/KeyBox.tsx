/** Colour key in a box inside a chart (top-left, or bottom-left with `bottom`). Used by every
 *  line chart so they all look the same. `left` = px from the chart's left edge (past the Y axis). */
export default function KeyBox({ items, bottom, left = 84 }: {
  items: { name: string; color: string }[];
  bottom?: boolean;
  left?: number;
}) {
  return (
    <div style={{ left }}
      className={`pointer-events-none absolute ${bottom ? "bottom-9" : "top-2"} z-10 rounded-md border border-border bg-bg/90 px-2.5 py-2 text-xs text-fg`}>
      {items.map((e) => (
        <div key={e.name} className="flex items-center gap-2 py-0.5">
          <span className="inline-block h-3 w-5 shrink-0 rounded-[2px]" style={{ background: e.color }} />
          <span className="whitespace-nowrap">{e.name}</span>
        </div>
      ))}
    </div>
  );
}
