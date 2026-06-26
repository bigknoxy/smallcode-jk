// Recursive-descent parser + evaluator for the tiny arithmetic language.
//
// It consumes the token stream produced by lexer.js. See lexer.js for the
// exact token object shape it relies on.
//
// Grammar:
//   expr   := term   (('+' | '-') term)*
//   term   := factor (('*' | '/') factor)*
//   factor := num | '(' expr ')'

import { tokenize } from './lexer.js';

export function parse(src) {
	const tokens = tokenize(src);
	let pos = 0;

	// Returns the category of the current token. It reads the category field
	// off the token object produced by the lexer.
	function peekKind() {
		return tokens[pos].kind;
	}

	function advance() {
		return tokens[pos++];
	}

	function expect(kind) {
		if (peekKind() !== kind) {
			throw new Error('Expected ' + kind + ' but got ' + peekKind());
		}
		return advance();
	}

	function factor() {
		if (peekKind() === 'lparen') {
			advance();
			const v = expr();
			expect('rparen');
			return v;
		}
		const tok = expect('num');
		return Number(tok.value);
	}

	function term() {
		let v = factor();
		while (peekKind() === 'star' || peekKind() === 'slash') {
			const op = advance();
			const rhs = factor();
			v = op.kind === 'star' ? v * rhs : v / rhs;
		}
		return v;
	}

	function expr() {
		let v = term();
		while (peekKind() === 'plus' || peekKind() === 'minus') {
			const op = advance();
			const rhs = term();
			v = op.kind === 'plus' ? v + rhs : v - rhs;
		}
		return v;
	}

	const result = expr();
	expect('eof');
	return result;
}
