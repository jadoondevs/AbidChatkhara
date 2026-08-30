/**
 * Every report is CSV-exportable (spec) — one small, generic serializer
 * rather than a bespoke formatter per report. Pure, no I/O: takes
 * whatever flat rows a report already returns and the column order to
 * use, and produces RFC 4180-ish CSV text (CRLF line endings, fields
 * quoted only when they contain a comma, quote, or newline, embedded
 * quotes doubled).
 */
export function toCsv<T extends Record<string, unknown>>(rows: readonly T[], columns: readonly (keyof T & string)[]): string {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const str = typeof value === 'string' ? value : JSON.stringify(value);
    return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };

  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((col) => escape(row[col])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
