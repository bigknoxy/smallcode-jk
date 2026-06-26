// Tokenizer for a tiny arithmetic expression language.
//
// Token contract (consumed by parser.js):
//   Each token is a plain object of the shape:
//     { kind: string, value: string }
//   where `kind` is one of: 'num', 'plus', 'minus', 'star', 'slash',
//   'lparen', 'rparen', and `value` is the matched source text.
//   A trailing { kind: 'eof', value: '' } token always terminates the stream.
//
// NOTE: the field carrying the token category is named `kind` (not `type`).

const SINGLES = {
	'+': 'plus',
	'-': 'minus',
	'*': 'star',
	'/': 'slash',
	'(': 'lparen',
	')': 'rparen',
};

export function tokenize(src) {
	const tokens = [];
	let i = 0;
	while (i < src.length) {
		const ch = src[i];

		if (ch === ' ' || ch === '\t' || ch === '\n') {
			i++;
			continue;
		}

		if (ch >= '0' && ch <= '9') {
			let j = i;
			while (j < src.length && src[j] >= '0' && src[j] <= '9') j++;
			tokens.push({ kind: 'num', value: src.slice(i, j) });
			i = j;
			continue;
		}

		const single = SINGLES[ch];
		if (single !== undefined) {
			tokens.push({ kind: single, value: ch });
			i++;
			continue;
		}

		throw new Error('Unexpected character: ' + ch);
	}

	tokens.push({ kind: 'eof', value: '' });
	return tokens;
}
