/** "Log scale" checkbox for a value chart. Unticked = the normal rupee scale (nothing changes);
 *  ticked = log scale, where the same % growth always has the same height. */
export default function LogToggle({ checked, onChange }: { checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex shrink-0 cursor-pointer items-center gap-2 text-sm text-fg-muted hover:text-fg"
      title="Log scale: the same % growth has the same height anywhere on the chart, so a straight line = steady yearly growth and a steeper line = faster growth. Untick for the normal rupee scale.">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
      Log scale
      {checked && <span className="hidden text-xs text-accent sm:inline">steeper line = faster % growth</span>}
    </label>
  );
}
