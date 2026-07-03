/**
 * Char-by-char scanner for a single CSV line. Handles quoted fields
 * (fields wrapped in `"..."`, which may themselves contain commas),
 * including RFC-4180 escaped double-quotes (`""` inside a quoted field
 * means a literal `"`).
 */
export function parseLine(line) {
	const fields = [];
	let field = "";
	let inQuotes = false;
	let i = 0;

	while (i < line.length) {
		const ch = line[i];

		if (inQuotes) {
			if (ch === '"') {
				if (line[i + 1] === '"') {
					field += '"';
					i += 2;
					continue;
				}
				inQuotes = false;
				i++;
				continue;
			}
			field += ch;
			i++;
			continue;
		}

		if (ch === '"') {
			inQuotes = true;
		} else if (ch === ",") {
			fields.push(field);
			field = "";
		} else {
			field += ch;
		}
		i++;
	}

	fields.push(field);
	return fields;
}
