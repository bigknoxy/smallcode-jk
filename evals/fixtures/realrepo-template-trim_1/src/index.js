import { tokenize } from "./tokenize.js";

/**
 * Render a `{{ var }}`-style template string against a data object.
 * Delegates parsing of the template into text/var tokens to tokenize().
 */
export default function render(tmpl, data) {
  var tokens = tokenize(tmpl);
  var out = "";

  for (var i = 0; i < tokens.length; i++) {
    var token = tokens[i];
    if (token.type === "text") {
      out += token.value;
    } else if (token.type === "var") {
      var value = data ? data[token.key] : undefined;
      out += value === undefined || value === null ? "" : String(value);
    }
  }

  return out;
}
