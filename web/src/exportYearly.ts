import writeXlsxFile from "write-excel-file/browser";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

function inr(n: number): string {
  return "Rs " + Math.round(n).toLocaleString("en-IN"); // PDF base fonts have no rupee glyph
}

// ---------- multi-table export (Rebalance page) ----------

export type Kind = "rupee" | "pct" | "pct2" | "signedRupee" | "num2" | "signedNum2";

export interface Table {
  headers: string[];
  rows: (string | number | null)[][];
  kinds: Record<number, Kind>;
  /** Optional group header row above `headers` (e.g. NIFTY over its Price / Qty / Value columns). */
  groups?: { label: string; span: number; color?: string }[];
  /** Optional lines written under the table. */
  notes?: string[];
  /** The headings already say "Rs": write rupee amounts as plain numbers (no "Rs " in each PDF cell). */
  plainRupees?: boolean;
}

function text(v: string | number | null, kind?: Kind, plain?: boolean): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (plain && (kind === "rupee" || kind === undefined)) return Math.round(v).toLocaleString("en-IN");
  if (kind === "pct") return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  if (kind === "pct2") return `${v.toFixed(2)}%`;
  if (kind === "signedRupee") return `${v >= 0 ? "+" : "-"}${inr(Math.abs(v))}`;
  if (kind === "num2") return v.toFixed(2);
  if (kind === "signedNum2") return `${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(2)}`;
  return inr(v);
}

const XL_FORMAT: Record<Kind, string> = {
  rupee: "#,##0", pct: "0.00", pct2: "0.00", signedRupee: "+#,##0;-#,##0;0",
  num2: "#,##0.00", signedNum2: "+#,##0.00;-#,##0.00;0.00",
};

export async function exportTablesExcel(fileName: string, sheets: { name: string; table: Table }[]) {
  const make = (t: Table) => [
    ...(t.groups
      ? [t.groups.flatMap((g) => [
          { value: g.label, columnSpan: g.span, fontWeight: "bold" as const, align: "center" as const, backgroundColor: g.color ?? "#D9DEEA" },
          ...Array.from({ length: g.span - 1 }, () => null),
        ])]
      : []),
    t.headers.map((h) => ({ value: h, fontWeight: "bold" as const, backgroundColor: "#E8ECF5", align: "center" as const, wrap: true })),
    ...t.rows.map((r) =>
      r.map((v, c) => {
        if (v === null || v === undefined) return { value: "—" };
        if (typeof v === "string") return { value: v };
        return { value: v, type: Number, format: XL_FORMAT[t.kinds[c] ?? "rupee"] };
      })
    ),
    ...(t.notes ? [[], ...t.notes.map((n) => [{ value: n, fontStyle: "italic" as const }])] : []),
  ];
  await writeXlsxFile(
    sheets.map((s) => ({
      data: make(s.table),
      sheet: s.name,
      columns: s.table.headers.map((_, i) => ({ width: i === 0 ? 16 : 20 })),
      stickyRowsCount: s.table.groups ? 2 : 1,
      stickyColumnsCount: 1,
    })) as never
  ).toFile(`${fileName}.xlsx`);
}

export function exportTablesPdf(
  fileName: string, title: string, subtitle: string,
  tables: { heading: string; table: Table }[]
) {
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  doc.setFontSize(14);
  doc.text(title, 40, 36);
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text(subtitle, 40, 52);
  let y = 66;
  for (const [i, { heading, table }] of tables.entries()) {
    if (i > 0) { doc.addPage(); y = 40; }       // every table starts on its own page
    doc.setFontSize(11);
    doc.setTextColor(30);
    doc.text(heading, 40, y + 8);
    autoTable(doc, {
      startY: y + 14,
      head: [
        ...(table.groups
          ? [table.groups.map((g) => ({
              content: g.label, colSpan: g.span,
              styles: { halign: "center" as const, fillColor: g.color ?? "#D9DEEA", textColor: 30 },
            }))]
          : []),
        table.headers,
      ],
      body: table.rows.map((r) => r.map((v, c) => text(v, table.kinds[c], table.plainRupees))),
      styles: { fontSize: table.headers.length > 12 ? 6 : 8, cellPadding: table.headers.length > 12 ? 2 : 3, halign: "right" },
      headStyles: { fillColor: [30, 38, 66], halign: "right" },
      columnStyles: { 0: { halign: "left" } },
      didParseCell: (h) => {
        if (h.section === "head" && h.column.index === 0) h.cell.styles.halign = "left";
      },
    });
    // @ts-expect-error lastAutoTable is added by the autotable plugin
    y = (doc.lastAutoTable?.finalY ?? y) + 10;
    if (table.notes) {
      doc.setFontSize(7);
      doc.setTextColor(110);
      for (const n of table.notes) { doc.text(n, 40, y + 6); y += 10; }
    }
    y += 14;
    if (y > 520) { doc.addPage(); y = 40; }
  }
  doc.save(`${fileName}.pdf`);
}
