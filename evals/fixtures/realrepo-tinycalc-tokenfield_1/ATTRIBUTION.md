Original code authored for the smallcode eval suite (MIT License).

`tinycalc` is a tiny self-contained arithmetic expression evaluator written as a
realistic two-file library: `src/lexer.js` tokenizes the source and `src/parser.js`
is a recursive-descent parser/evaluator that consumes those tokens. It is not
vendored from any upstream project; it exists to exercise cross-file edits where a
bug in one file (the parser) can only be fixed correctly by reading the token-shape
contract documented and produced by another file (the lexer).
