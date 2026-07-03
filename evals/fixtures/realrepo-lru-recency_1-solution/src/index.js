export default function createLRU(max) {
	const map = new Map();

	function get(key) {
		if (!map.has(key)) {
			return undefined;
		}
		const val = map.get(key);
		map.delete(key);
		map.set(key, val);
		return val;
	}

	function set(key, val) {
		if (map.has(key)) {
			map.delete(key);
		}
		map.set(key, val);
		if (map.size > max) {
			const oldestKey = map.keys().next().value;
			map.delete(oldestKey);
		}
	}

	function keys() {
		return Array.from(map.keys());
	}

	return { get, set, keys };
}
