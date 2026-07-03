export default function compare(a, b) {
	const [aCore, aPre] = splitVersion(a);
	const [bCore, bPre] = splitVersion(b);
	for (let i = 0; i < 3; i++) {
		if (aCore[i] !== bCore[i]) return aCore[i] > bCore[i] ? 1 : -1;
	}
	return comparePrerelease(aPre, bPre);
}

function splitVersion(v) {
	const [core, pre] = v.split("-");
	const parts = core.split(".").map(Number);
	const preParts = pre ? pre.split(".") : null;
	return [parts, preParts];
}

function comparePrerelease(aPre, bPre) {
	if (!aPre && !bPre) return 0;
	if (!aPre) return 1;
	if (!bPre) return -1;
	const len = Math.max(aPre.length, bPre.length);
	for (let i = 0; i < len; i++) {
		const ai = aPre[i];
		const bi = bPre[i];
		if (ai === undefined) return -1;
		if (bi === undefined) return 1;
		const an = Number(ai);
		const bn = Number(bi);
		const aIsNum = !Number.isNaN(an);
		const bIsNum = !Number.isNaN(bn);
		if (aIsNum && bIsNum) {
			if (an !== bn) return an > bn ? 1 : -1;
		} else if (ai !== bi) {
			return ai > bi ? 1 : -1;
		}
	}
	return 0;
}
