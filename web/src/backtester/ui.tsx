// Small shared components for the backtester pages (same look as the rest of the app).
import type { ReactNode } from "react";

export function Card({ title, action, children, note }: { title: string; action?: ReactNode; children: ReactNode; note?: ReactNode }) {
  return (
    <section className="mb-5 rounded-xl border border-border bg-panel p-4">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h3 className="text-lg font-semibold text-fg">{title}</h3>
        {action}
      </div>
      {note && <p className="mb-3 text-sm text-fg-muted">{note}</p>}
      {children}
    </section>
  );
}

export function ErrorBox({ errors }: { errors: string[] }) {
  if (!errors.length) return null;
  return (
    <div className="mb-4 rounded-lg border border-danger/50 bg-danger/10 px-3.5 py-2.5 text-sm text-danger">
      {errors.length === 1 ? errors[0] : <ul className="list-disc pl-5">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}
    </div>
  );
}

