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
	if (key.endsWith("[]")) {
		const base = key.slice(0, -2);
		if (!Array.isArray(target[base])) {
			target[base] = [];
		}
		target[base].push(val);
	} else {
		target[key] = val;
	}
}
