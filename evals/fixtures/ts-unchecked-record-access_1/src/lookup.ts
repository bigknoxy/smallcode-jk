const map: Record<string, number> = { a: 1 };
const val: number | undefined = map["a"];
console.log((val ?? 0) + 1);
