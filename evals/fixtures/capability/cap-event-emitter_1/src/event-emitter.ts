export class EventEmitter {
  private listeners: Map<string, Function[]> = new Map();

  on(event: string, listener: Function): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(listener);
  }

  off(event: string, listener: Function): void {
    const fns = this.listeners.get(event);
    if (!fns) return;
    const idx = fns.indexOf(listener);
    if (idx !== -1) {
      fns.splice(idx, 1);
    }
  }

  emit(event: string, ...args: unknown[]): void {
    const fns = this.listeners.get(event);
    if (!fns) return;
    for (const fn of [...fns]) {
      fn(...args);
    }
  }
}
