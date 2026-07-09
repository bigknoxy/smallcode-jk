import { formatUSD } from "./money.js";

// Sum each line item (price × quantity) and return the total formatted as USD.
export function receiptTotal(items) {
	let cents = 0;
	for (const it of items) {
		cents += it.priceCents * it.qty;
	}
	return formatUSD(cents);
}
