import { makePerson } from "./person.js";

// Return a person's full name as "First Last".
export function fullName(first, last) {
	const p = makePerson(first, last);
	return p.first + " " + p.last;
}
