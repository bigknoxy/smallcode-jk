import { parseLine } from "./lexer.js";

/**
 * Parse a minimal CSV document into a matrix of strings.
 *
 *   parse('a,b\n"x,y",z') // => [["a","b"], ["x,y","z"]]
 */
export default function parse(input) {
	if (input === "") return [];
	const lines = input.split(/\r\n|\n/);
	return lines.map((line) => parseLine(line));
}
