/**
 * Split a template string into an array of tokens:
 *   { type: "text", value: string }
 *   { type: "var", key: string }
 *
 * Variable spans are written as `{{ name }}`; the whitespace inside the
 * braces around the key is allowed and should not become part of the key.
 */
export function tokenize(tmpl) {
  var tokens = [];
  var re = /\{\{(.*?)\}\}/g;
  var lastIndex = 0;
  var match;

  while ((match = re.exec(tmpl)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: "text", value: tmpl.slice(lastIndex, match.index) });
    }

    // BUG: the raw capture group still has leading/trailing whitespace
    // (e.g. " name "), so it's used verbatim as the lookup key instead
    // of being trimmed down to "name".
    var rawKey = match[1];
    tokens.push({ type: "var", key: rawKey });

    lastIndex = re.lastIndex;
  }

  if (lastIndex < tmpl.length) {
    tokens.push({ type: "text", value: tmpl.slice(lastIndex) });
  }

  return tokens;
}
