import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { type ModelProfile, ModelProfileSchema } from "../models/types.ts";
import { type SmallcodeConfig, SmallcodeConfigSchema } from "./types.ts";

const ConfigFileSchema = z.object({
  config: SmallcodeConfigSchema,
  models: z.array(ModelProfileSchema).optional(),
});

export interface LoadedConfig {
  config: SmallcodeConfig;
  extraModels: ModelProfile[];
}

export function loadConfig(configPath?: string): LoadedConfig {
  // If an explicit path was given, use only that path (no default fallback).
  const candidates: string[] =
    configPath !== undefined ? [configPath] : ["smallcode.config.json", ".smallcode.json"];

  for (const candidate of candidates) {
    const abs = resolve(candidate);
    if (!existsSync(abs)) continue;

    const raw = JSON.parse(readFileSync(abs, "utf8")) as unknown;
    const parsed = ConfigFileSchema.safeParse(raw);

    if (!parsed.success) {
      throw new Error(`Config file "${abs}" is invalid:\n${parsed.error.message}`);
    }

    return {
      config: parsed.data.config,
      extraModels: parsed.data.models ?? [],
    };
  }

  throw new Error(
    `No config file found. Create smallcode.config.json with "config" and optional "models" keys.`,
  );
}

export function loadConfigFromEnv(): Partial<SmallcodeConfig> {
  const baseUrl = process.env["SMALLCODE_BASE_URL"];
  const model = process.env["SMALLCODE_MODEL"];
  return {
    ...(baseUrl ? { provider: { baseUrl, apiKey: "none", timeoutMs: 120_000 } } : {}),
    ...(model ? { activeModel: model } : {}),
  };
}
