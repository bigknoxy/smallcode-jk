export function divide(a: number, b: number): number {
  if (b === 0) throw new Error("divide: divisor must not be zero");
  return a / b;
}
