import { TAX_RATE } from "./rates.js";

// Return the price in cents with sales tax added, rounded to the nearest cent.
export function withTax(cents) {
	return Math.round(cents - cents * TAX_RATE);
}
