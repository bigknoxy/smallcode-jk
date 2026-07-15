const FLIPS = { "+": "-", "-": "+" };
const OP_RE = /\+|-/g;
export function mutateOps(src) {
	const out = [];
	for (const m of src.matchAll(OP_RE)) {
		const to = FLIPS[m[0]];
		if (to === undefined) continue;
		out.push(src.slice(0, m.index) + to + src.slice(m.index + m[0].length));
	}
	return out;
}
