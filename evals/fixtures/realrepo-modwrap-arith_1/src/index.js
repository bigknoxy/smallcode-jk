export default function wrapIndex(i, len) {
	return ((i % len) - len) % len;
}
