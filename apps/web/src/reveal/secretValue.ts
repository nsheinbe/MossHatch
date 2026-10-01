/**
 * The only shape plaintext takes in the browser (PLAN 4.5, store contract layer 2). The value sits in a private field; printing,
 * serialising or inspecting it gives "[secret]", and the only way to read it is `expose(fn)`. `drop()` forgets the reference.
 * JavaScript strings cannot be zeroed, so dropping is best effort: the string becomes unreachable and the collector takes it.
 * Only `src/reveal/` may import this file (checked in boundary.test.ts).
 */
export class SecretValue {
  #v: string | null;
  constructor(v: string) { this.#v = v; }
  /** Runs `fn` with the plaintext. Throws once dropped, so a stale holder cannot show an old value. */
  expose<T>(fn: (v: string) => T): T {
    if (this.#v === null) throw new Error("dropped");
    return fn(this.#v);
  }
  get dropped(): boolean { return this.#v === null; }
  drop(): void { this.#v = null; }
  toString(): string { return "[secret]"; }
  toJSON(): string { return "[secret]"; }
  [Symbol.for("nodejs.util.inspect.custom")](): string { return "[secret]"; }
}
