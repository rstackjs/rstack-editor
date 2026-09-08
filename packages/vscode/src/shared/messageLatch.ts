/** Suppresses consecutive identical messages until the owning operation recovers. */
export class MessageLatch {
  #message: string | undefined;

  get current(): string | undefined {
    return this.#message;
  }

  changed(message: string): boolean {
    if (this.#message === message) return false;
    this.#message = message;
    return true;
  }

  clear(): void {
    this.#message = undefined;
  }
}
