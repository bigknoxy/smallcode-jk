interface User { name: string; profile?: { email: string }; }
/** Return the emails of every user that has a profile. */
export function emails(users: User[]): string[] {
  return users.map((u) => u.profile.email);
}
