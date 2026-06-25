// Word-wrapping utilities.
//
// The public entry point is `wrapText`, which performs a greedy word wrap of
// the input text to a maximum line width. Words are never split across lines
// unless a single word is itself longer than the target width, in which case
// the word is hard-split into width-sized chunks (see `breakLongWord`).
//
// Several small internal helpers are exported so they can be unit-tested in
// isolation. This module is intentionally verbose: it is the "large file"
// case in the edit-reliability fixture set.

/**
 * Split a block of text into individual words.
 *
 * Whitespace (spaces, tabs, newlines) is collapsed: any run of whitespace is
 * treated as a single separator and empty tokens are discarded. The returned
 * array therefore contains no empty strings.
 */
export function splitWords(text: string): string[] {
  const words: string[] = [];
  let current = "";
  for (const ch of text) {
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (current.length > 0) {
        words.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) {
    words.push(current);
  }
  return words;
}

/**
 * Hard-split a single word that is longer than `width` into a list of chunks,
 * each at most `width` characters long. Words shorter than or equal to the
 * width are returned unchanged as a single-element array.
 *
 * A width of zero or less is treated as a width of 1 to avoid an infinite
 * loop — callers should guard against that, but we stay defensive here.
 */
export function breakLongWord(word: string, width: number): string[] {
  const safeWidth = width < 1 ? 1 : width;
  if (word.length <= safeWidth) {
    return [word];
  }
  const chunks: string[] = [];
  let start = 0;
  while (start < word.length) {
    const end = start + safeWidth;
    chunks.push(word.slice(start, end));
    start = end;
  }
  return chunks;
}

/**
 * Pad a string on the right with spaces so that it reaches `width` characters.
 * Strings already at or beyond the requested width are returned unchanged.
 */
export function padRight(s: string, width: number): string {
  if (s.length >= width) {
    return s;
  }
  let out = s;
  while (out.length < width) {
    out += " ";
  }
  return out;
}

/**
 * Greedily wrap `text` to lines no longer than `width` characters.
 *
 * Returns an array of lines (without trailing newlines). Empty input yields a
 * single empty line. Words longer than `width` are hard-split via
 * `breakLongWord`. Words are joined by a single space within a line.
 */
export function wrapText(text: string, width: number): string[] {
  const effectiveWidth = width < 1 ? 1 : width;
  const rawWords = splitWords(text);

  // Expand any over-long word into multiple width-sized fragments up front so
  // the greedy packing loop below only ever deals with words that fit.
  const words: string[] = [];
  for (const word of rawWords) {
    if (word.length > effectiveWidth) {
      for (const piece of breakLongWord(word, effectiveWidth)) {
        words.push(piece);
      }
    } else {
      words.push(word);
    }
  }

  if (words.length === 0) {
    return [""];
  }

  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length === 0) {
      // First word on the line always fits (it is <= width by construction).
      line = word;
      continue;
    }
    // +1 accounts for the single space that would join the word to the line.
    if (line.length + 1 + word.length < effectiveWidth) {
      line += " " + word;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) {
    lines.push(line);
  }
  return lines;
}
