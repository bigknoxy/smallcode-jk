import { createEmitter } from "./core.js";

/**
 * Create a new mitt-style event emitter.
 *
 *   const e = emitter();
 *   e.on("greet", handler);
 *   e.emit("greet", "world");
 *   e.off("greet", handler);
 */
export default function emitter() {
	return createEmitter();
}
