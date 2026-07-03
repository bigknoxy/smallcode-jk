/**
 * Internals for the mitt-style event emitter: a Map<type, handler[]>
 * plus the on/off/emit operations over it.
 */
export function createEmitter() {
	const handlersByType = new Map();

	function on(type, handler) {
		const handlers = handlersByType.get(type);
		if (handlers) {
			handlers.push(handler);
		} else {
			handlersByType.set(type, [handler]);
		}
	}

	function off(type, handler) {
		const handlers = handlersByType.get(type);
		if (!handlers) return;
		const i = handlers.indexOf(handler);
		handlers.splice(i, 1);
	}

	function emit(type, ...args) {
		const handlers = handlersByType.get(type);
		if (!handlers) return;
		for (const handler of handlers.slice()) {
			handler(...args);
		}
	}

	return { on, off, emit };
}
