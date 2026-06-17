interface ModelProfile {
  id: string;
  temperature: number;
  maxTokens: number;
}

export class ModelRegistry {
  private profiles = new Map<string, ModelProfile>();

  register(profile: ModelProfile): void {
    this.profiles.set(profile.id, profile);
  }

  get(id: string): ModelProfile {
    const profile = this.profiles.get(id);
    if (!profile) throw new Error(`Unknown model: ${id}`);
    return profile;
  }
}
