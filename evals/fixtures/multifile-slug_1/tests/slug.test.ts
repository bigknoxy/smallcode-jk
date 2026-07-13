import { expect, test } from "bun:test";
import { slugify } from "../src/index.js";

// slugify must lowercase, trim, and hyphen-join the words of a title.
test("trims and hyphenates a padded title", () => {
	expect(slugify("  Hello World  ")).toBe("hello-world");
});

test("hyphenates a multi-word title", () => {
	expect(slugify("Foo Bar Baz")).toBe("foo-bar-baz");
});
