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
	// BUG: the "no prerelease beats prerelease" rule is inverted, so a
	// release version is (wrongly) treated as lower precedence than the
	// same version with a prerelease tag attached.
	if (!aPre && !bPre) return 0;
	if (!aPre) return -1;
	if (!bPre) return 1;
	const as = aPre.join(".");
	const bs = bPre.join(".");
	return as === bs ? 0 : as > bs ? 1 : -1;
}
