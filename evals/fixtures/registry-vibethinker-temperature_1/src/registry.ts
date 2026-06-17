interface ModelProfile {
  id: string;
  temperature: number;
  maxTokens: number;
}

const BUILTIN_PROFILES: ModelProfile[] = [
  { id: "vibethinker-3b", temperature: 1.0, maxTokens: 4096 },
];

export class ModelRegistry {
  private profiles = new Map<string, ModelProfile>(
    BUILTIN_PROFILES.map((p) => [p.id, p]),
  );

  get(id: string): ModelProfile {
    const profile = this.profiles.get(id);
    if (!profile) throw new Error(`Unknown model: ${id}`);
    return profile;
  }
}
