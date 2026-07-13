import { normalize } from "./normalize.js";

// Turn a title into a hyphen-separated URL slug (e.g. "  Hello World  " -> "hello-world").
export function slugify(title) {
	return normalize(title).split(/\s+/).join("_");
}
