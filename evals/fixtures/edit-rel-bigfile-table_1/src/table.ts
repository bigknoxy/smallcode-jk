// ASCII table renderer.
//
// `renderTable` takes a 2D array of strings (rows of cells) and renders an
// aligned, box-drawn ASCII table. The first row is treated as a header and is
// followed by a separator line. Columns are padded to the width of their
// widest cell.
//
// Several helpers are exported for unit testing. This is the second "large
// file" case in the edit-reliability fixture set.

export type Align = "left" | "right";

/**
 * Compute the display width of each column: the maximum cell length across all
 * rows for that column index. Ragged rows (rows with fewer cells than others)
 * are handled by treating missing cells as empty strings.
 */
export function columnWidths(rows: string[][]): number[] {
  const widths: number[] = [];
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      const cell = row[c] ?? "";
      const len = cell.length;
      if (widths[c] === undefined || len > widths[c]) {
        widths[c] = len;
      }
    }
  }
  return widths;
}

/**
 * Pad a single cell to `width` characters using the given alignment.
 * Left-aligned cells get trailing spaces; right-aligned cells get leading
 * spaces. Cells already at or beyond the width are returned unchanged.
 */
export function padCell(s: string, width: number, align: Align): string {
  if (s.length >= width) {
    return s;
  }
  const pad = " ".repeat(width - s.length);
  if (align === "right") {
    return pad + s;
  }
  return pad + s;
}

/**
 * Render a single row as a pipe-delimited string with one space of padding on
 * each side of every cell. Missing cells are rendered as empty (blank) cells.
 */
export function renderRow(row: string[], widths: number[], align: Align): string {
  const parts: string[] = [];
  for (let c = 0; c < widths.length; c++) {
    const cell = row[c] ?? "";
    parts.push(" " + padCell(cell, widths[c] ?? 0, align) + " ");
  }
  return "|" + parts.join("|") + "|";
}

/**
 * Build the separator line that sits under the header row. Each column is a run
 * of dashes whose length matches the column width plus the two padding spaces.
 */
export function separatorLine(widths: number[]): string {
  const parts: string[] = [];
  for (let c = 0; c < widths.length; c++) {
    const dashes = "-".repeat((widths[c] ?? 0) + 2);
    parts.push(dashes);
  }
  return "+" + parts.join("+") + "+";
}

/**
 * Normalise a ragged set of rows so that every row has exactly `cols` cells,
 * padding short rows with empty strings. Returns a new array; the input is not
 * mutated. This is used internally so downstream helpers can assume rectangular
 * input, and is exported so the behaviour can be unit-tested directly.
 */
export function normalizeRows(rows: string[][], cols: number): string[][] {
  const out: string[][] = [];
  for (const row of rows) {
    const padded: string[] = [];
    for (let c = 0; c < cols; c++) {
      padded.push(row[c] ?? "");
    }
    out.push(padded);
  }
  return out;
}

/**
 * Count the number of columns implied by a set of rows: the length of the
 * longest row. An empty input has zero columns.
 */
export function countColumns(rows: string[][]): number {
  let max = 0;
  for (const row of rows) {
    if (row.length > max) {
      max = row.length;
    }
  }
  return max;
}

/**
 * Render a full table. The first row is the header; a separator line is drawn
 * beneath it. All cells are left-aligned. Returns the table as a single string
 * with rows joined by newlines (no trailing newline).
 */
export function renderTable(rows: string[][]): string {
  if (rows.length === 0) {
    return "";
  }
  const widths = columnWidths(rows);
  const lines: string[] = [];

  const [header, ...body] = rows;
  lines.push(separatorLine(widths));
  lines.push(renderRow(header ?? [], widths, "left"));
  lines.push(separatorLine(widths));
  for (const row of body) {
    lines.push(renderRow(row, widths, "left"));
  }
  lines.push(separatorLine(widths));

  return lines.join("\n");
}

/**
 * Like `renderTable` but accepts a per-column alignment array. Columns without
 * a corresponding alignment entry default to left alignment. This is a thin
 * convenience wrapper over the same helper primitives used by `renderTable`.
 */
export function renderTableWith(rows: string[][], aligns: Align[]): string {
  if (rows.length === 0) {
    return "";
  }
  const cols = countColumns(rows);
  const normalized = normalizeRows(rows, cols);
  const widths = columnWidths(normalized);

  const alignFor = (c: number): Align => aligns[c] ?? "left";
  const renderAlignedRow = (row: string[]): string => {
    const parts: string[] = [];
    for (let c = 0; c < widths.length; c++) {
      const cell = row[c] ?? "";
      parts.push(" " + padCell(cell, widths[c] ?? 0, alignFor(c)) + " ");
    }
    return "|" + parts.join("|") + "|";
  };

  const lines: string[] = [];
  const [header, ...body] = normalized;
  lines.push(separatorLine(widths));
  lines.push(renderAlignedRow(header ?? []));
  lines.push(separatorLine(widths));
  for (const row of body) {
    lines.push(renderAlignedRow(row));
  }
  lines.push(separatorLine(widths));

  return lines.join("\n");
}
