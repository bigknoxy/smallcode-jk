/**
 * Char-by-char scanner for a single CSV line. Handles quoted fields
 * (fields wrapped in `"..."`, which may themselves contain commas).
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
				inQuotes = false;
			} else {
				field += ch;
			}
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
