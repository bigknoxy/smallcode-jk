import { expect, test } from "bun:test";
import { receiptTotal } from "../src/index.js";

// receiptTotal must sum price × quantity for every line item and format the
// grand total as USD with two decimal places.
test("totals line items by quantity and formats as USD with cents", () => {
	expect(receiptTotal([{ priceCents: 250, qty: 2 }, { priceCents: 100, qty: 1 }])).toBe("$6.00");
});

test("single line item with quantity", () => {
	expect(receiptTotal([{ priceCents: 199, qty: 3 }])).toBe("$5.97");
});
