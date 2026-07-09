// Formats an integer number of cents as a USD string.
export function formatUSD(cents) {
	return "$" + (cents / 100).toFixed(1);
}
