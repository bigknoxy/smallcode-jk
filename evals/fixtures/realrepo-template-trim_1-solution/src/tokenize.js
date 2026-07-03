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

    // FIX: capture the raw span, then trim it before using it as the key
    // so " name " correctly resolves to data.name.
    var rawKey = match[1];
    var key = rawKey.trim();
    tokens.push({ type: "var", key: key });

    lastIndex = re.lastIndex;
  }

  if (lastIndex < tmpl.length) {
    tokens.push({ type: "text", value: tmpl.slice(lastIndex) });
  }

  return tokens;
}
