## HARD RULE — docs NEVER drift from code (MANDATORY, NON-NEGOTIABLE)

**Every `.html` and `.md` file in the repo MUST stay in sync with the codebase at all times.** This is not limited to the three public pages below — it covers `README.md`, `docs/*.html`, `docs/*.md` (including `docs/roadmap.html`, `docs/harness-engineering-roadmap.md`, `docs/ROADMAP.md`), and any other doc/markdown file. A commit that changes behavior, features, flags, env vars, config, commands, module structure, or benchmark numbers WITHOUT updating every doc/markdown file that references the changed thing is INCOMPLETE.

On every commit: (1) grep the `.html`/`.md` files for anything your change affects (feature name, flag, env var, command, module, number); (2) update every match; (3) if genuinely none apply, state `docs: no doc/markdown impact` in the commit body so the skip is deliberate, not forgotten. Stale docs are a bug — treat a doc that contradicts the code as a defect to fix, not to ignore. When unsure whether a doc claim is still true, VERIFY it against the code before leaving it.

## Public docs sync (MANDATORY)

Three public pages live at repo root / `docs/` and WILL be published to GitHub Pages in a later phase. They must NEVER drift from the code:

- **`index.html`** — landing page. What smallcode is (coding harness making small local models output real code), headline benchmark numbers, quick start, prominent links to the architecture + docs pages.
- **`docs/architecture.html`** — living design document. Mermaid diagrams of the agent loop (planTask → executor turns → edit-apply → graders), tool-exec + test-oracle early-stop flow, edit-format pipeline, eval/benchmark harness. Footer timestamp = today.
- **`docs/llms.html`** — reference for LLMs and devs. Module map, tool contracts, edit formats, config/env vars, how to run evals/benchmarks. Dense, factual, link-rich.

**On EVERY commit, run this checklist:**
1. Loop/routing/tool/edit-format/early-stop logic changed → update architecture diagrams + llms.html flow.
2. Feature/endpoint/config/env-var added or removed → update index.html quick start + llms.html.
3. Benchmark/eval numbers changed → update headline numbers in index.html AND any tables in architecture.html.
4. New script in `scripts/` or new module in `src/` → add to llms.html module map.
5. Update `docs/architecture.html` footer timestamp to today.

Pages must be standalone HTML (no build step) — open-in-browser must work. If a change touches code but none of the above, state "docs: no public-page impact" in the commit body so the skip is deliberate, not forgotten.

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
