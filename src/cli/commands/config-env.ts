import { ENV_REGISTRY } from "../../config/env.ts";

export async function configEnvCommand(): Promise<void> {
  process.stdout.write("Runtime env-var flags (read from the environment at process start):\n");

  for (const v of ENV_REGISTRY) {
    const line = `  ${v.name.padEnd(28)} [${v.parse}]  default=${v.default}  ${v.description}`;
    process.stdout.write(`${line}\n`);
  }
}
