import type { QmlElement } from "@mocha-framework/core/qml";
import type { ChildControllerInfo } from "./child-component-info.js";
import { tagToSelector } from "./child-component-info.js";

/**
 * Angular code emission for a child controller usage.
 *
 * Given a `<Child { name: x, value: controller.shared }>` QML element
 * and the child controller's static metadata, emit the equivalent
 * Angular template:
 *
 *   <app-child [name]="x" [(value)]="shared()" (clickedChange)="onClicked($event)">
 *   </app-child>
 *
 * The output is suitable for inclusion in a parent component's template.
 */

export interface ChildBindingsContext {
  /** Map of child tag → metadata. */
  childRegistry: Map<string, ChildControllerInfo>;
  /** Set of component class names to import in the parent. */
  childImports: Set<string>;
  /** The Angular component selector prefix (default: `app`). */
  selectorPrefix: string;
}

export function walkChildComponent(
  el: QmlElement,
  indent: number,
  ctx: ChildBindingsContext
): string {
  const info = ctx.childRegistry.get(el.tag);
  if (!info) {
    // Shouldn't happen — caller checks the registry first.
    return "";
  }

  ctx.childImports.add(`${info.className}Component`);

  const pad = "  ".repeat(indent);
  const selector = tagToSelector(info.tag, ctx.selectorPrefix);

  const inputBindings: string[] = [];
  const modelBindings: string[] = [];
  const outputBindings: string[] = [];

  for (const [key, value] of Object.entries(el.attrs)) {
    if (key === "id") continue;

    // Translate the parent-side expression:
    //   `controller.x`     → `x()`  (read signal)
    //   `controller.x.foo` → `x().foo` (chain)
    //   `controller.method()` → unsupported, drop with a warning
    const translated = translateParentExpr(value);

    if (info.modelNames.includes(key)) {
      modelBindings.push(`[(${key})]="${translated}"`);
    } else if (info.inputNames.includes(key) || info.qpropertyNames.includes(key)) {
      inputBindings.push(`[${key}]="${translated}"`);
    } else if (info.outputNames.includes(key)) {
      // Outputs become `(nameChange)="handler($event)"` — Angular convention.
      // The user is expected to have a method named `onName` in the controller.
      const handlerName = `on${capitalize(key)}`;
      outputBindings.push(`(${key}Change)="${handlerName}($event)"`);
    } else {
      // Unknown field — pass through as a generic attribute, in case it's
      // a QML-only prop the child handles internally.
      inputBindings.push(`[${key}]="${translated}"`);
    }
  }

  const allBindings = [...inputBindings, ...modelBindings, ...outputBindings].join(" ");
  const attrString = allBindings ? ` ${allBindings}` : "";

  if (el.children.length === 0) {
    return `${pad}<${selector}${attrString}></${selector}>`;
  }

  // Recurse children (e.g. <Child><Button /></Child> → projection slot)
  const childPieces: string[] = [];
  for (const c of el.children) {
    if (c.tag === "#text") {
      const text = c.body?.trim();
      if (text) childPieces.push(`${pad}  ${text}`);
    } else {
      // For now, render children as a projection block
      childPieces.push(`${pad}  <ng-content></ng-content>`);
    }
  }
  return `${pad}<${selector}${attrString}>\n${childPieces.join("\n")}\n${pad}</${selector}>`;
}

function translateParentExpr(expr: string): string {
  let v = expr.trim();
  // Strip surrounding quotes for string literals — Angular template
  // accepts both `attr="foo"` and `[attr]="'foo'"`. The compiler already
  // strips quotes in the QML parser, so this is a no-op for most cases.
  v = v.replace(/^["'](.*)["']$/, "$1");

  // controller.X.value → X()
  v = v.replace(/controller\.(\w+)\.value/g, "$1()");
  // controller.X → X() (when not followed by .)
  v = v.replace(/controller\.(\w+)(?!\.)/g, "$1()");
  return v;
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
