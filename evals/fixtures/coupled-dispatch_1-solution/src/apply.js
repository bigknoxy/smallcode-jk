const KINDS = new Set(["add", "sub", "mul"]);
export function applyOp(kind, a, b) {
	if (!KINDS.has(kind)) throw new Error("unknown kind: " + kind);
	switch (kind) {
		case "add": return a + b;
		case "sub": return a - b;
		case "mul": return a * b;
	}
}
