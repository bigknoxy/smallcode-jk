export default function parse(qs) {
	const result = {};
	if (!qs) return result;
	const str = qs.startsWith("?") ? qs.slice(1) : qs;
	const pairs = str.split("&").filter(Boolean);
	for (const pair of pairs) {
		const [rawKey, rawVal = ""] = pair.split("=");
		const key = decodeURIComponent(rawKey);
		const val = decodeURIComponent(rawVal);
		assign(result, key, val);
	}
	return result;
}

function assign(target, key, val) {
	// BUG: never checks for a `[]` suffix, so bracket-array keys are just
	// treated like any other key and overwritten on each repeat instead of
	// being collected into an array.
	target[key] = val;
}
