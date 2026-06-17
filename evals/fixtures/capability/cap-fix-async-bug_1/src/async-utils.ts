async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchValue(): Promise<number> {
  await delay(1);
  return 42;
}

export async function getDoubledValue(): Promise<number> {
  const value = await fetchValue();
  return value * 2;
}
