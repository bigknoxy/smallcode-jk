function makeKey(args) {
	return String(args[0]);
}

export default function memoize(fn) {
	const cache = new Map();

	return function memoized(...args) {
		const key = makeKey(args);
		if (cache.has(key)) {
			return cache.get(key);
		}
		const result = fn(...args);
		cache.set(key, result);
		return result;
	};
}
