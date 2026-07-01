export interface ParsedArgs {
  command: string; // "run" | "eval" | "config" | "help" | "version"
  subcommand?: string; // "run" | "gate" | "init" | "list-models"
  positionals: string[]; // remaining positional args
  flags: Record<string, string | boolean>;
}

/**
 * Minimal arg parser — no external deps.
 *
 * Supported patterns:
 *   smallcode run <task description...> [--json]
 *   smallcode fix [--repo <path>] [--test "<cmd>"] [--model <id>] [--best-of-n <n>] [--escalation <m1,m2>] [--json] [--max-turns <n>]
 *   smallcode eval run <suite-dir> [--model <id>] [--trials <n>] [--output json|text]
 *   smallcode eval gate <suite-dir> [--threshold 0.9] [--allow-delta 0.05]
 *   smallcode config init [--model <id>] [--endpoint <url>] [--output <path>]
 *   smallcode config list-models
 *   smallcode config env
 *   smallcode --version / -v
 *   smallcode --help / -h
 */
export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) {
    return { command: "help", positionals: [], flags: {} };
  }

  const flags: Record<string, string | boolean> = {};
  const remaining: string[] = [];

  // Pass 1: collect flags and non-flag tokens
  let i = 0;
  while (i < argv.length) {
    const token = argv[i] ?? "";

    if (token === "--version" || token === "-v") {
      return { command: "version", positionals: [], flags: {} };
    }

    if (token === "--help" || token === "-h") {
      return { command: "help", positionals: [], flags: {} };
    }

    if (token.startsWith("--")) {
      // --flag=value or --flag value or --flag (boolean)
      const eqIdx = token.indexOf("=");
      if (eqIdx !== -1) {
        const key = token.slice(2, eqIdx);
        const value = token.slice(eqIdx + 1);
        flags[key] = value;
      } else {
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      remaining.push(token);
    }

    i++;
  }

  if (remaining.length === 0) {
    return { command: "help", positionals: [], flags };
  }

  const [cmd, ...rest] = remaining as [string, ...string[]];

  // Top-level commands with subcommands
  if (cmd === "eval") {
    const sub = rest[0];
    if (sub === "run" || sub === "gate") {
      return {
        command: "eval",
        subcommand: sub,
        positionals: rest.slice(1),
        flags,
      };
    }
    return { command: "eval", positionals: rest, flags };
  }

  if (cmd === "config") {
    const sub = rest[0];
    if (sub === "init" || sub === "list-models" || sub === "env") {
      return {
        command: "config",
        subcommand: sub,
        positionals: rest.slice(1),
        flags,
      };
    }
    return { command: "config", positionals: rest, flags };
  }

  if (cmd === "run") {
    return { command: "run", positionals: rest, flags };
  }

  if (cmd === "fix") {
    return { command: "fix", positionals: rest, flags };
  }

  if (cmd === "update") {
    return { command: "update", positionals: rest, flags };
  }

  if (cmd === "uninstall") {
    return { command: "uninstall", positionals: rest, flags };
  }

  if (cmd === "chat") {
    return { command: "chat", positionals: rest, flags };
  }

  if (cmd === "diff") {
    return { command: "diff", positionals: rest, flags };
  }

  if (cmd === "undo") {
    return { command: "undo", positionals: rest, flags };
  }

  if (cmd === "help") {
    return { command: "help", positionals: rest, flags };
  }

  if (cmd === "version") {
    return { command: "version", positionals: rest, flags };
  }

  // Unknown command — fall through to help (caller can exit 1)
  return { command: cmd, positionals: rest, flags };
}
