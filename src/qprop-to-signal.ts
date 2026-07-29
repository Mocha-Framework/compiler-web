import { Signal, signal } from '@angular/core';
import { QProperty } from '@mocha/core';

function filter<T>(qprop: QProperty<T>, fn: (v: T) => void): () => void {
  return qprop.onValue(fn);
}

/**
 * Converts a `@mocha/core` `QProperty<T>` to an Angular `Signal<T>`.
 *
 * The returned signal stays in sync with the QProperty:
 *   - When the QProperty changes → the Angular signal updates
 *   - Angular change detection is triggered automatically (via signal.set())
 *
 * Usage in generated component:
 * ```typescript
 * count = toQSignal(this.controller.count);
 * template: `<p>{{ count() }}</p>`
 * ```
 */
export function toQSignal<T>(qprop: QProperty<T>): Signal<T> {
  const sig = signal<T>(qprop.value);
  filter(qprop, (value: T) => sig.set(value));
  return sig.asReadonly();
}

/**
 * Converts a `QProperty<T>` into a writable interface.
 * Two-way binding: Angular writes propagate back to the QProperty.
 */
export function toWritableQSignal<T>(
  qprop: QProperty<T>
): { readonly: Signal<T>; set: (value: T) => void; update: (fn: (v: T) => T) => void } {
  const sig = signal<T>(qprop.value);
  filter(qprop, (value: T) => sig.set(value));

  return {
    readonly: sig.asReadonly(),
    set: (value: T) => {
      qprop.value = value;
      sig.set(value);
    },
    update: (fn: (v: T) => T) => {
      const newValue = fn(qprop.value);
      qprop.value = newValue;
      sig.set(newValue);
    },
  };
}
