interface Cell { value: number; }
/** A tiny stack of numbered cells. */
export class Stack {
  private items: Cell[] = [];
  push(n: number): void { this.items.push({ value: n }); }
  /** Return the value on top of the stack without removing it. */
  peek(): number {
    return this.items[this.items.length].value;
  }
}
