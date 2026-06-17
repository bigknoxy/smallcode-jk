/**
 * Parse a single CSV row into fields.
 * Handles quoted fields (double-quotes) that may contain commas.
 * Example: 'a,"b,c",d' => ['a', 'b,c', 'd']
 */
export function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (i === line.length) {
      // End of line — push empty field if line ends with comma
      break;
    }
    if (line[i] === '"') {
      // Quoted field
      i++; // skip opening quote
      let field = "";
      while (i < line.length && line[i] !== '"') {
        field += line[i];
        i++;
      }
      i++; // skip closing quote
      fields.push(field);
      if (i < line.length && line[i] === ",") i++; // skip comma
    } else {
      // Unquoted field
      let field = "";
      while (i < line.length && line[i] !== ",") {
        field += line[i];
        i++;
      }
      fields.push(field);
      if (i < line.length && line[i] === ",") i++; // skip comma
    }
  }
  return fields;
}
