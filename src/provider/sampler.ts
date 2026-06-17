import type { ModelProfile, SamplingDefaults } from "../models/types.ts";

export function buildSamplingParams(
  profile: ModelProfile,
  overrides: Partial<SamplingDefaults>,
): SamplingDefaults {
  return {
    temperature: overrides.temperature ?? profile.samplingDefaults.temperature,
    top_p: overrides.top_p ?? profile.samplingDefaults.top_p,
    top_k: overrides.top_k ?? profile.samplingDefaults.top_k,
    max_tokens: overrides.max_tokens ?? profile.samplingDefaults.max_tokens,
  };
}
