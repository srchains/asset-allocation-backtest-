import writeXlsxFile from "write-excel-file/browser";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

export interface YearlyExport {
  title: string;
  subtitle: string;
  headers: string[];
  /** First column is text; every other column is a number, or null for "—". */
  rows: (string | number | null)[][];
  /** Column index -> "rupee" | "pct" (anything not listed is shown as is). */
  kinds: Record<number, "rupee" | "pct">;
  fileName: string;
}

function inr(n: number): string {
  return "Rs " + Math.round(n).toLocaleString("en-IN"); // PDF base fonts have no rupee glyph
}

function cellText(v: string | number | null, kind?: "rupee" | "pct"): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (kind === "pct") return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  return inr(v);
}

export async function exportYearlyExcel(d: YearlyExport) {
  const head = d.headers.map((h) => ({ value: h, fontWeight: "bold" as const, backgroundColor: "#E8ECF5" }));
  const body = d.rows.map((r) =>
    r.map((v, c) => {
      if (v === null || v === undefined) return { value: "—" };
      if (typeof v === "string") return { value: v };
      return d.kinds[c] === "pct"
        ? { value: v, type: Number, format: "0.00" }
        : { value: v, type: Number, format: "#,##0" };
    })
  );
  await writeXlsxFile([head, ...body] as never, {
    columns: d.headers.map((_, i) => ({ width: i === 0 ? 14 : 16 })),
  } as never).toFile(`${d.fileName}.xlsx`);
}

export function exportYearlyPdf(d: YearlyExport) {
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  doc.setFontSize(14);
  doc.text(d.title, 40, 36);
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text(d.subtitle, 40, 52);
  autoTable(doc, {
    startY: 64,
    head: [d.headers],
    body: d.rows.map((r) => r.map((v, c) => cellText(v, d.kinds[c]))),
    styles: { fontSize: 8, cellPadding: 4, halign: "right" },
    headStyles: { fillColor: [30, 38, 66], halign: "right" },
    columnStyles: { 0: { halign: "left" } },
    didParseCell: (h) => {
      if (h.section === "head" && h.column.index === 0) h.cell.styles.halign = "left";
    },
  });
  doc.save(`${d.fileName}.pdf`);
}

// ---------- multi-table export (Rebalance page) ----------

export type Kind = "rupee" | "pct" | "pct2" | "signedRupee" | "num2" | "signedNum2";

export interface Table {
  headers: string[];
  rows: (string | number | null)[][];
  kinds: Record<number, Kind>;
}

function text(v: string | number | null, kind?: Kind): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
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
    t.headers.map((h) => ({ value: h, fontWeight: "bold" as const, backgroundColor: "#E8ECF5" })),
    ...t.rows.map((r) =>
      r.map((v, c) => {
        if (v === null || v === undefined) return { value: "—" };
        if (typeof v === "string") return { value: v };
        return { value: v, type: Number, format: XL_FORMAT[t.kinds[c] ?? "rupee"] };
      })
    ),
  ];
  await writeXlsxFile(
    sheets.map((s) => ({
      data: make(s.table),
      sheet: s.name,
      columns: s.table.headers.map((_, i) => ({ width: i === 0 ? 14 : 18 })),
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
  for (const { heading, table } of tables) {
    doc.setFontSize(11);
    doc.setTextColor(30);
    doc.text(heading, 40, y + 8);
    autoTable(doc, {
      startY: y + 14,
      head: [table.headers],
      body: table.rows.map((r) => r.map((v, c) => text(v, table.kinds[c]))),
      styles: { fontSize: table.headers.length > 12 ? 6 : 8, cellPadding: table.headers.length > 12 ? 2 : 3, halign: "right" },
      headStyles: { fillColor: [30, 38, 66], halign: "right" },
      columnStyles: { 0: { halign: "left" } },
      didParseCell: (h) => {
        if (h.section === "head" && h.column.index === 0) h.cell.styles.halign = "left";
      },
    });
    // @ts-expect-error lastAutoTable is added by the autotable plugin
    y = (doc.lastAutoTable?.finalY ?? y) + 24;
    if (y > 520) { doc.addPage(); y = 40; }
  }
  doc.save(`${fileName}.pdf`);
}
