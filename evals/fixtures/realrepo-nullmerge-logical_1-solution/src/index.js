export default function coalesce(a, b) {
	if (a == null && b == null) return null;
	return a != null ? a : b;
}
