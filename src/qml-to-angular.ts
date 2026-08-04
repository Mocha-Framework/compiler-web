import { QmlAstParser } from '@mocha-framework/core/qml';
import type { QmlElement, QmlDocument } from '@mocha-framework/core/qml';
import { preprocessPlatformDirectives } from './platform-directives.js';
import type { Platform, HtmlBlock } from './platform-directives.js';
import { getElementDef, hasQmlNgComponent } from './element-mapper.js';
import { walkChildComponent, type ChildBindingsContext } from './child-component-codegen.js';
import type { ChildControllerInfo } from './child-component-info.js';
import { transformControllerClass } from './controller-codegen.js';

export type { Platform, HtmlBlock };

const parser = new QmlAstParser();

export interface RouteConfig {
  path: string;
  componentSource: string;
}

export interface CompiledComponent {
  componentTs: string;
  template: string;
  styles: string;
  angularImports: string[];
  qmlNgImports: string[];
  hasRouter: boolean;
  routes: RouteConfig[];
  warnings: string[];
}

export interface CompileOptions {
  target: Platform;
  selector: string;
  className: string;
  controllerSource: string;
  controllerName: string;
  qpropertyNames: string[];
  methodNames: string[];
  /** Optional: registry of child controllers known at codegen time. */
  childRegistry?: Map<string, ChildControllerInfo>;
  /** Optional: Angular selector prefix for child components (default: `app`). */
  childSelectorPrefix?: string;
}

export function compileQmlToAngular(
  qmlTemplate: string,
  options: CompileOptions
): CompiledComponent {
  const target = options.target ?? 'web';
  const warnings: string[] = [];

  const stripped = qmlTemplate
    .split('\n')
    .filter((l) => !l.trim().startsWith('import ') && !l.trim().startsWith('pragma '))
    .join('\n')
    .trim();

  const processed = preprocessPlatformDirectives(stripped, target);

  if (processed.hasWebBlocks && !hasQmlElements(processed.cleaned)) {
    return compileWebBlocks(processed, options);
  }

  const angularImports = new Set<string>(['Component']);
  const qmlNgImports = new Set<string>();
  let hasRouter = false;

  const document = parser.parse(processed.cleaned);
  if (!document.root) {
    warnings.push('No root QML element found');
    return fallbackEmpty(options);
  }

  const routes: RouteConfig[] = [];

  const ctx: WalkCtx = {
    angularImports,
    qmlNgImports,
    componentDirectiveImports: new Set<string>(),
    routerImports: new Set<string>(),
    htmlBlocks: processed.htmlBlocks,
    hasRouterRef: { value: false },
    routes,
    warnings,
    childRegistry: options.childRegistry ?? new Map(),
    childImports: new Set<string>(),
    childSelectorPrefix: options.childSelectorPrefix ?? 'app',
    qpropertyNames: new Set(options.qpropertyNames ?? []),
  };

  const elementsToWalk =
    isWindow(document.root)
      ? document.root.children
      : [document.root];

  const templateParts: string[] = [];
  for (const el of elementsToWalk) {
    const html = walkElement(el, 0, ctx);
    if (html) templateParts.push(html);
  }

  hasRouter = ctx.hasRouterRef.value;
  const template = templateParts.join('\n');

  const componentTs = buildComponent(template, options, angularImports, qmlNgImports, routes, ctx.childImports, ctx.componentDirectiveImports, ctx.routerImports);

  return {
    componentTs,
    template,
    styles: '',
    angularImports: [...angularImports],
    qmlNgImports: [...qmlNgImports],
    hasRouter,
    routes,
    warnings,
  };
}

// ── AST walker ──

interface WalkCtx {
  angularImports: Set<string>;
  qmlNgImports: Set<string>;
  /** Imports from `@angular/router` (RouterLink, RouterLinkActive, RouterOutlet). */
  routerImports: Set<string>;
  /** Directives/pipes (RouterLink, RouterLinkActive, NgFor, …) that must also be
   *  listed in the generated component's `imports: []` so Angular activates them. */
  componentDirectiveImports: Set<string>;
  htmlBlocks: HtmlBlock[];
  hasRouterRef: { value: boolean };
  routes: RouteConfig[];
  warnings: string[];
  childRegistry: Map<string, ChildControllerInfo>;
  childImports: Set<string>;
  childSelectorPrefix: string;
  /** Names of controller fields decorated with `@qproperty` — only these become
   *  signal calls (`controller.X` → `X()`). Other fields stay as plain property access. */
  qpropertyNames: Set<string>;
}

function isWindow(el: QmlElement): boolean {
  return el.tag === 'ApplicationWindow' || el.tag === 'Window';
}

/**
 * In the new Angular-pure model, every property on the controller class IS
 * a signal. So `controller.X` and `this.X` both become bare `X` (which the
 * template calls as `X()` to read). The class IS the component, so there's
 * no `ctrl.X` indirection.
 *
 * - `controller.X.value`     → `X()`
 * - `controller.X`           → `X`
 * - `this.X.value`           → `X()`
 * - `this.X`                 → `X`
 * - `controller.X.value.foo` → `X().foo` (chained access on signal value)
 */
function translateControllerRef(value: string): string {
  // Walk character-by-character so we don't break on strings or nested braces.
  let out = '';
  let i = 0;
  let depth = 0;
  let inStr: '"' | "'" | null = null;

  while (i < value.length) {
    const ch = value[i];

    if (inStr) {
      out += ch;
      if (ch === '\\' && i + 1 < value.length) {
        out += value[i + 1];
        i += 2;
        continue;
      }
      if (ch === inStr) inStr = null;
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inStr = ch as '"' | "'";
      out += ch;
      i++;
      continue;
    }

    if (ch === '(' || ch === '{' || ch === '[') {
      depth++;
      out += ch;
      i++;
      continue;
    }
    if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      out += ch;
      i++;
      continue;
    }

    // Match `controller.X.value` or `this.X.value` followed by `.`, `=`, `+`, `-`, etc.
    const ctrlVal = value.slice(i).match(/^(?:controller|this)\.(\w+)\.value\b/);
    if (ctrlVal) {
      out += `${ctrlVal[1]}()`;
      i += ctrlVal[0].length;
      continue;
    }

    // Match `(controller|this).X` (any remaining — strip prefix)
    const ctrl = value.slice(i).match(/^(?:controller|this)\.(\w+)/);
    if (ctrl) {
      out += ctrl[1];
      i += ctrl[0].length;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

function walkElement(el: QmlElement, indent: number, ctx: WalkCtx): string {
  const pad = '  '.repeat(indent);

  const rawMatch = el.tag.match(/^MochaRawHtml(\d+)$/);
  if (rawMatch) {
    const block = ctx.htmlBlocks.find((b) => b.placeholder === el.tag);
    if (block && block.html.trim()) return pad + block.html.trim();
    return '';
  }

  if (el.tag === '#text') {
    const text = el.body?.trim();
    if (text && !text.startsWith('__MOCHA_HTML_')) return pad + text;
    return '';
  }

  // ── Router handling (Angular-specific) ──
  if (el.tag === 'Router') {
    ctx.hasRouterRef.value = true;
    // RouterOutlet is now imported alongside provideRouter in buildComponent
    for (const child of el.children) {
      if (child.tag === 'Route') {
        const source = child.attrs.source || '';
        const path = child.attrs.path || '/';
        const cleanSource = source
          .replace(/^Qt\.resolvedUrl\(["']|["']\)$/g, '')
          .replace(/^["']|["']$/g, '');
        ctx.routes.push({ path, componentSource: cleanSource });
      }
    }
    return pad + '<router-outlet></router-outlet>';
  }

  if (el.tag === 'RouterLink') {
    ctx.routerImports.add('RouterLink');
    ctx.routerImports.add('RouterLinkActive');
    ctx.componentDirectiveImports.add('RouterLink');
    ctx.componentDirectiveImports.add('RouterLinkActive');
    const path = resolvePath(el.attrs.to || el.attrs.source || el.attrs.path || '/');
    const compactText = el.attrs.text;
    const childrenHtml = walkChildren(el, indent + 1, ctx);
    let inner = '';
    if (childrenHtml) {
      inner = `\n${childrenHtml}\n${pad}`;
    } else if (compactText) {
      inner = `<span [innerText]="'${compactText.replace(/'/g, "\\'")}'"></span>`;
    }
    return pad + `<a routerLink="${path}" routerLinkActive="active">${inner}</a>`;
  }

  // ── Repeater (Angular @for) ──
  if (el.tag === 'Repeater') {
    const model = el.attrs.model || '';
    const modelBinding = model.replace(/^controller\./, '').replace(/\.value$/, '');
    if (modelBinding && !modelBinding.startsWith('controller')) {
      return pad + `@for (item of ${modelBinding}(); track $index) {\n` +
        walkChildren(el, indent + 1, ctx) +
        `\n${pad}}`;
    }
    return pad + '<ng-container>\n' + walkChildren(el, indent + 1, ctx) + `\n${pad}</ng-container>`;
  }

  if (el.tag === 'Image' || el.tag === 'AnimatedImage') {
    const src = el.attrs.source || '';
    return pad + `<img src="${src}" />`;
  }

  // ── Child component (user-defined controller class) ──
  if (ctx.childRegistry.has(el.tag)) {
    const childCtx: ChildBindingsContext = {
      childRegistry: ctx.childRegistry,
      childImports: ctx.childImports,
      selectorPrefix: ctx.childSelectorPrefix,
    };
    return walkChildComponent(el, indent, childCtx);
  }

  // ── Check qml-ng registry first ──
  const qmlNgTag = hasQmlNgComponent(el.tag);
  if (qmlNgTag) {
    const def = getElementDef(el.tag);
    if (def) {
      ctx.qmlNgImports.add(el.tag);
      // Angular matches components by selector, not by class name. Use
      // `def.tag` (the resolved selector) for the HTML tag, while keeping
      // `el.tag` (the class name) as the import binding.
      const tag = def.tag;
      const attrs = formatAttrsSimple(el, '', ctx.qpropertyNames);
      const childrenHtml = walkChildren(el, indent + 1, ctx);
      if (!childrenHtml) return pad + `<${tag}${attrs}></${tag}>`;
      return pad + `<${tag}${attrs}>\n${childrenHtml}\n${pad}</${tag}>`;
    }
  }

  // ── Fallback: old element map or div ──
  const def = getElementDef(el.tag);
  const props = parseQmlProps(el.body);
  const childrenHtml = walkChildren(el, indent + 1, ctx);

  if (def && !qmlNgTag) {
    const attrs = formatAttrsFallback(el, '', ctx.qpropertyNames);
    const tag = def.tag;
    const content = childrenHtml || extractStaticText(el.body);
    if (!content) return pad + `<${tag}${attrs}></${tag}>`;
    if (!childrenHtml) return pad + `<${tag}${attrs}>${content}</${tag}>`;
    return pad + `<${tag}${attrs}>\n${content}\n${pad}</${tag}>`;
  }

  ctx.warnings.push(`Unknown QML element: ${el.tag}, rendered as <div>`);
  const attrs = formatAttrsFallback(el, '', ctx.qpropertyNames);
  const content = childrenHtml || extractStaticText(el.body);
  if (!content) return pad + `<div${attrs}></div>`;
  if (!childrenHtml) return pad + `<div${attrs}>${content}</div>`;
  return pad + `<div${attrs}>\n${content}\n${pad}</div>`;
}

function walkChildren(el: QmlElement, indent: number, ctx: WalkCtx): string {
  const parts: string[] = [];
  for (const child of el.children) {
    const html = walkElement(child, indent, ctx);
    if (html) parts.push(html);
  }
  return parts.join('\n');
}

// ── Simplified pass-through formatting for qml-ng components ──

function formatAttrsSimple(el: QmlElement, _baseClass: string, qpropertyNames: Set<string>): string {
  const parts: string[] = [];
  for (const [rawKey, rawValue] of Object.entries(el.attrs)) {
    // Filter out QML-internal props not relevant to Angular
    if (rawKey.startsWith('anchors.') || rawKey === 'id' || rawKey === 'x' || rawKey === 'y' || rawKey === 'z' || rawKey === 'width' || rawKey === 'height') continue;
    if (rawKey === 'visible' || rawKey === 'enabled' || rawKey === 'clip' || rawKey === 'opacity') continue;
    // Skip font.* boolean attributes (qml-ng handles these via CSS)
    // Keep font.pixelSize, font.pointSize, font.family as they map to qml-ng inputs
    if (rawKey === 'font.bold' || rawKey === 'font.italic' || rawKey === 'font.underline' || rawKey === 'font.weight') continue;

    // Detect whether the rawValue is a *pure* string literal (just `"..."` or
    // `'...'`) versus a JS-like expression that happens to start/end with
    // a quote (e.g. `"Count: " + count()`). We treat it as a literal only
    // when the inner content has no other quote characters.
    let value = rawValue;
    let wasQuoted = false;
    let wasBlock = false;
    const outerQuote = (value.startsWith('"') || value.startsWith("'")) ? value[0] : null;
    if (outerQuote && value[value.length - 1] === outerQuote && value.length >= 2) {
      const inner = value.slice(1, -1);
      if (!inner.includes('"') && !inner.includes("'")) {
        wasQuoted = true;
        value = inner;
      }
    } else if (value.startsWith('{') && value.endsWith('}')) {
      wasBlock = true;
      value = value.slice(1, -1).trim();
    }

    // Convert QML dotted properties to camelCase (font.pixelSize → fontPixelSize)
    const mappedKey = rawKey.replace(/\.([a-zA-Z])/g, (_, c) => c.toUpperCase());

    const binding = mapBindingSimple(mappedKey, value, wasQuoted, qpropertyNames, wasBlock);
    if (binding) parts.push(binding);
  }
  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}

function mapBindingSimple(key: string, value: string, wasQuoted: boolean, qpropertyNames: Set<string>, wasBlock: boolean = false): string | null {
  // Translate controller.X → X() ONLY for QProperty signals
  const translatedValue = translateControllerRef(value);

// Event handlers: QML onClicked → Angular (click)
  if (key.startsWith('on') && /^on[A-Z]/.test(key)) {
    const event = mapEvent(key);
    let body = translatedValue;
    if (wasBlock) body = body.replace(/^\{|\}$/g, '').trim();
    // The body is the actual method body. In the Angular-pure model the
    // class IS the component, so the method is called directly (no
    // `ctrl.` indirection). The `chain` regex matches `global().increment(...)`
    // → `global().increment($event)` and `increment()` → `increment($event)`.
    const chain = body.match(/^(\w+(?:\(\))?)\.(\w+)\(/);
    if (chain) return `${event}="${chain[1]}.${chain[2]}($event)"`;
    const fn = body.match(/^(\w+)\(/);
    if (fn) return `${event}="${fn[1]}($event)"`;
    return `${event}='${body.replace(/'/g, "\\'")}'`;
  }

  // Controller binding (single property access)
  if (value.startsWith('controller.')) {
    const m = value.match(/^controller\.(\w+)(?:\.value)?$/);
    if (m && qpropertyNames.has(m[1])) return `[${key}]="${m[1]}()"`;
    if (m) return `[${key}]="${m[1]}"`;
    return `[${key}]="${translatedValue}"`;
  }

  // i18n
  if (value.startsWith('MochaI18n.')) {
    let expr = value.replace(/^MochaI18n\./, '');
    expr = translateControllerRef(expr);
    if (key === 'text' || key === 'title' || key === 'label') {
      return `[innerText]="i18n(${expr})"`;
    }
    return `[${key}]="i18n(${expr})"`;
  }

  // Service access
  const get = value.match(/^(\w+)\.get\("(\w+)"\)$/);
  if (get) return `[${key}]="${get[1]}.${get[2]}"`;

  // Theme reference — translate QML Theme.colors.X to Catppuccin CSS variable
  if (value.startsWith('Theme.')) {
    const colorName = value.replace(/^Theme\.colors\./, '').replace(/^Theme\./, '');
    // Map common Catppuccin color names to CSS custom property names
    const cssVar = colorToCssVar(colorName);
    return `[${key}]="${cssVar}"`;
  }
  // Static values
  if (value === 'true') return key;
  if (value === 'false') return `[${key}]="false"`;
  if (/^-?\d+(\.\d+)?$/.test(value)) return `[${key}]="${value}"`;

  // Check if value contains quotes that would break HTML attribute syntax
  const hasDoubleQ = translatedValue.includes('"');
  const hasSingleQ = translatedValue.includes("'");
  if (hasDoubleQ && !hasSingleQ) return `[${key}]='${translatedValue}'`;
  if (hasDoubleQ && hasSingleQ) return `[${key}]="${translatedValue.replace(/"/g, '&quot;')}"`;

  // Pass through as string attribute
  // SAFETY NET: if the original QML value was a quoted string literal, wrap
  // it in quotes so Angular parses it as a string instead of a JS identifier
  // (e.g. `text: "About"` → `[innerText]="'About'"`, not `[innerText]="About"`).
  if (wasQuoted) {
    const escaped = translatedValue.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `[${key}]="'${escaped}'"`;
  }
  return `[${key}]="${translatedValue}"`;
}

// ── Old fallback formatter (for non-qml-ng elements) ──

function formatAttrsFallback(el: QmlElement, _unused: string, qpropertyNames: Set<string>): string {
  const parts: string[] = [];
  for (const [rawKey, rawValue] of Object.entries(el.attrs)) {
    if (shouldSkip(rawKey)) continue;
    if (rawKey === 'id') continue;
    if (rawKey === 'text' && !rawValue.startsWith('controller.') && !rawValue.includes('(')) continue;

    let value = rawValue;
    let wasQuoted = false;
    const outerQuote = (value.startsWith('"') || value.startsWith("'")) ? value[0] : null;
    if (outerQuote && value[value.length - 1] === outerQuote && value.length >= 2) {
      const inner = value.slice(1, -1);
      if (!inner.includes('"') && !inner.includes("'")) {
        wasQuoted = true;
        value = inner;
      }
    } else if (value.startsWith('{') && value.endsWith('}')) {
      value = value.slice(1, -1).trim();
    }

    const binding = mapBindingFallback(rawKey, value, wasQuoted, qpropertyNames);
    if (binding) parts.push(binding);
  }
  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}

function shouldSkip(key: string): boolean {
  return [
    'anchors.fill', 'anchors.centerIn', 'anchors.left', 'anchors.right',
    'anchors.top', 'anchors.bottom', 'anchors.verticalCenter',
    'anchors.horizontalCenter', 'anchors.margins',
    'font.family', 'font.pixelSize', 'font.pointSize', 'font.bold',
    'font.italic', 'font.underline', 'font.weight',
    'Layout.fillWidth', 'Layout.fillHeight',
    'width', 'height', 'x', 'y', 'z',
    'visible', 'enabled', 'clip', 'opacity',
    'activeFocusOnTab', 'focus', 'activeFocus',
    'bottomPadding', 'topPadding', 'leftPadding', 'rightPadding',
    'padding', 'spacing',
  ].includes(key);
}

function mapBindingFallback(key: string, value: string, wasQuoted: boolean, qpropertyNames: Set<string>): string | null {
  const fullyTranslated = translateControllerRef(value);

  if (key.startsWith('on') && /^on[A-Z]/.test(key)) {
    const event = mapEvent(key);
    const chain = fullyTranslated.match(/^(\w+(?:\(\))?)\.(\w+)\(/);
    if (chain) return `${event}="${chain[1]}.${chain[2]}($event)"`;
    const fn = fullyTranslated.match(/^(\w+)\(/);
    if (fn) return `${event}="${fn[1]}($event)"`;
    return `${event}='${fullyTranslated.replace(/'/g, "\\'")}'`;
  }

  if (value.startsWith('controller.')) {
    const m = value.match(/^controller\.(\w+)(?:\.value)?$/);
    if (m && qpropertyNames.has(m[1])) {
      const prop = m[1];
      return key === 'text' || key === 'label' || key === 'title'
        ? `[innerText]="${prop}()"`
        : `[${key}]="${prop}()"`;
    }
    if (m) {
      const prop = m[1];
      return key === 'text' || key === 'label' || key === 'title'
        ? `[innerText]="${prop}"`
        : `[${key}]="${prop}"`;
    }
    return key === 'text' || key === 'label' || key === 'title'
      ? `[innerText]="${fullyTranslated}"`
      : `[${key}]="${fullyTranslated}"`;
  }

  if (value.startsWith('MochaI18n.')) {
    let expr = value.replace(/^MochaI18n\./, '');
    expr = translateControllerRef(expr);
    return `[innerText]="i18n(${expr})"`;
  }

  const get = value.match(/^(\w+)\.get\("(\w+)"\)$/);
  if (get) return `[${key}]="${get[1]}.${get[2]}"`;

  const method = value.match(/^(\w+)\.(\w+)\(/);
  if (method && method[1] !== 'MochaI18n' && method[1] !== 'Theme') {
    const event = mapEvent(key.startsWith('on') ? key : `on${key[0].toUpperCase() + key.slice(1)}`);
    return `${event}="ctrl.callRoot('${method[1]}', '${method[2]}')"`;
  }

  if (key.startsWith('on') && /^on[A-Z]/.test(key)) {
    const eventName = key.slice(2);
    const lc = eventName.charAt(0).toLowerCase() + eventName.slice(1);
    let body = value.replace(/^\{|\}$/g, '').trim();
    if (body.startsWith('{')) body = body.slice(1).trim();
    if (body.endsWith('}')) body = body.slice(0, -1).trim();
    return `(${lc})='${body.replace(/'/g, "\\'")}'`;
  }

  if (value.startsWith('Theme.')) {
    const colorName = value.replace(/^Theme\.colors\./, '').replace(/^Theme\./, '');
    return `[${key}]="${colorToCssVar(colorName)}"`;
  }
  if (value === 'true') return key;
  if (value === 'false') return `[${key}]="false"`;
  if (/^-?\d+(\.\d+)?$/.test(value)) return `[${key}]="${value}"`;
  if (value.includes('"')) return `[${key}]='${fullyTranslated}'`;
  if (value.includes("'")) return `[${key}]="${fullyTranslated}"`;
  // SAFETY NET: quoted-string literal — wrap in quotes so Angular treats it
  // as a string, not a JS identifier reference (e.g. "About" → 'About').
  if (wasQuoted) {
    const escaped = fullyTranslated.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `[${key}]="'${escaped}'"`;
  }
  return `[${key}]="${fullyTranslated}"`;
}

function mapEvent(signal: string): string {
  const m: Record<string, string> = {
    onClicked: '(click)', onDoubleClicked: '(dblclick)',
    onPressed: '(mousedown)', onReleased: '(mouseup)',
    onEntered: '(mouseenter)', onExited: '(mouseleave)',
    onTextChanged: '(input)', onEditingFinished: '(change)',
    onCheckedChanged: '(change)', onValueChanged: '(input)',
    onCurrentIndexChanged: '(change)', onActivated: '(activate)',
    onAccepted: '(submit)', onCompleted: '(load)',
    onTriggered: '(trigger)',
  };
  return m[signal] ?? `(${signal.slice(2).toLowerCase()})`;
}

function colorToCssVar(name: string): string {
  // Catppuccin color names → CSS custom properties (used by qml-ng).
  // Wrapped in quotes because JIT compiler treats attribute values
  // as JS expressions and `var` is a reserved keyword.
  const map: Record<string, string> = {
    text: "var(--qml-text, var(--ctp-text, #cdd6f4))",
    subtext0: "var(--qml-subtext0, var(--ctp-subtext0, #a6adc8))",
    subtext1: "var(--qml-subtext1, var(--ctp-subtext1, #bac2de))",
    background: "var(--qml-background, var(--ctp-base, #1e1e2e))",
    surface: "var(--qml-surface, var(--ctp-mantle, #181825))",
    mauve: "var(--qml-mauve, var(--ctp-mauve, #cba6f7))",
    teal: "var(--qml-teal, var(--ctp-teal, #94e2d5))",
    yellow: "var(--qml-yellow, var(--ctp-yellow, #f9e2af))",
    green: "var(--qml-green, var(--ctp-green, #a6e3a1))",
    red: "var(--qml-red, var(--ctp-red, #f38ba8))",
    blue: "var(--qml-blue, var(--ctp-blue, #89b4fa))",
    overlay0: "var(--qml-overlay0, var(--ctp-overlay0, #6c7086))",
    overlay1: "var(--qml-overlay1, var(--ctp-overlay1, #7f849c))",
    surface0: "var(--qml-surface0, var(--ctp-surface0, #313244))",
    surface1: "var(--qml-surface1, var(--ctp-surface1, #45475a))",
  };
  return `'${map[name] ?? name}'`;
}

// ── Property parsing (unchanged from original) ──

function parseQmlProps(body: string): [string, string, boolean][] {
  const props: [string, string, boolean][] = [];
  let i = 0;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let key = '';
  let value = '';
  let afterColon = false;

  while (i < body.length) {
    const ch = body[i];
    const n = body[i + 1] ?? '';

    if (inLineComment) { if (ch === '\n') inLineComment = false; i++; continue; }
    if (inBlockComment) { if (ch === '*' && n === '/') { inBlockComment = false; i += 2; } else i++; continue; }
    if (inSingle) { if (ch === '\\') { i += 2; continue; } if (ch === "'") inSingle = false; if (afterColon) value += ch; i++; continue; }
    if (inDouble) { if (ch === '\\') { i += 2; continue; } if (ch === '"') inDouble = false; if (afterColon) value += ch; i++; continue; }
    if (ch === '/' && n === '/') { inLineComment = true; i += 2; continue; }
    if (ch === '/' && n === '*') { inBlockComment = true; i += 2; continue; }
    if (ch === "'") { inSingle = true; if (afterColon) value += ch; i++; continue; }
    if (ch === '"') { inDouble = true; if (afterColon) value += ch; i++; continue; }

    if (ch === '{') {
      if (afterColon) value += ch;
      depth++;
      i++;
      continue;
    }
    if (ch === '}') {
      if (depth > 0) { if (afterColon) value += ch; depth--; i++; continue; }
      if (key && afterColon) pushProp(key, value.trim(), props);
      key = ''; value = ''; afterColon = false;
      break;
    }

    if (depth > 0 && !afterColon) { i++; continue; }
    if (depth > 0 && afterColon) { value += ch; i++; continue; }

    if (ch === ';' && afterColon && depth === 0) {
      const v = value.trim();
      if (v) pushProp(key, v, props);
      key = ''; value = ''; afterColon = false;
      i++; continue;
    }

    if (ch === '\n') {
      if (key && afterColon) {
        const v = value.trim();
        if (v) pushProp(key, v, props);
        key = ''; value = ''; afterColon = false;
      } else if (key) {
        key = ''; value = ''; afterColon = false;
      }
      i++; continue;
    }

    if (afterColon) {
      value += ch;
    } else if (ch === ':') {
      afterColon = true;
    } else if (!/[\s]/.test(ch)) {
      key += ch;
    }

    i++;
  }

  if (key && afterColon) pushProp(key, value.trim(), props);
  return props;
}

function pushProp(rawKey: string, rawValue: string, props: [string, string, boolean][]) {
  let v = rawValue;
  const wasQuoted =
    (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) ||
    (v.length >= 2 && v.startsWith("'") && v.endsWith("'"));
  if (wasQuoted) v = v.slice(1, -1);
  props.push([rawKey, v, wasQuoted]);
}

// ── Helpers ──

function extractStaticText(body: string): string | null {
  const m = body.match(/text\s*:\s*"([^"]*)"\s*$/m);
  return m ? m[1] : null;
}

function hasQmlElements(qml: string): boolean {
  return /[A-Z]\w+\s*\{/.test(qml);
}

function resolvePath(src: string): string {
  return src
    .replace(/^["']|["']$/g, '')
    .replace(/^Qt\.resolvedUrl\(["']|["']\)$/g, '');
}

function stripTypeAnnotations(js: string): string {
  return js
    .replace(/: \w+(?:<[^>]*>)?(?=\s*[{=,])/g, '')
    .replace(/\.\.\.\w+: any\[\]/g, (m) => m.replace(/: any\[\]/, ''));
}

function stripDecoLines(js: string): string {
  return js
    .split('\n')
    .filter(l => {
      const t = l.trim();
      if (!t.startsWith('@')) return true;
      const rest = t.slice(1).trim();
      const head = rest.split(/\s|\(/)[0];
      return ['qproperty', 'QMLComponent', 'qml'].includes(head);
    })
    .join('\n');
}

// ── Component builder ──

function buildComponent(
  template: string,
  options: CompileOptions,
  angularImports: Set<string>,
  qmlNgImports: Set<string>,
  routes: RouteConfig[] = [],
  childImports: Set<string> = new Set(),
  componentDirectiveImports: Set<string> = new Set(),
  routerImports: Set<string> = new Set(),
): string {
  const e = template.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\${/g, '\\${');
  const lines: string[] = [];

  // Transform the controller source into a pure Angular component class
  const transform = transformControllerClass(options.controllerSource, options.controllerName);

  // Build the set of Angular symbols we need to import
  const angularSymbols = new Set<string>([...angularImports]);
  if (transform) {
    // Always need signal() for properties; computed() if any @qcomputed
    angularSymbols.add('signal');
    if (transform.computedNames.length > 0) angularSymbols.add('computed');
    if (transform.viewChildNames.length > 0) {
      angularSymbols.add('viewChild');
      angularSymbols.add('ElementRef');
    }
    if (transform.inputNames.length > 0) angularSymbols.add('input');
    if (transform.outputNames.length > 0) angularSymbols.add('output');
    if (transform.additionalImports.includes('batch')) {
      // Angular 20 does not export batch — we emit sequential set() calls instead
    }
    // Always add 'inject' if the transform detected injected services
    if (transform.injectNames.length > 0) {
      angularSymbols.add('inject');
    }
  }

  lines.push(`import { ${[...angularSymbols].sort().join(', ')} } from '@angular/core';`);

  if (qmlNgImports.size > 0) {
    const names = [...qmlNgImports].sort();
    lines.push(`import { ${names.join(', ')} } from '@mocha-framework/qml-ng';`);
  }

  // Emit a single `@angular/router` import containing RouterOutlet (when routes
  // were extracted) plus any RouterLink/RouterLinkActive referenced in the QML.
  const routerImportNames = new Set<string>();
  if (routes.length > 0) routerImportNames.add('RouterOutlet');
  for (const name of routerImports) routerImportNames.add(name);
  if (routerImportNames.size > 0) {
    lines.push(`import { ${[...routerImportNames].sort().join(', ')} } from '@angular/router';`);
  }

  // Emit imports for injected services (global-state, etc.)
  if (transform && transform.injectClasses && transform.injectClasses.length > 0) {
    for (const name of transform.injectClasses) {
      const kebab = name.replace(/([A-Z])/g, '-$1').toLowerCase().replace(/^-/, '');
      lines.push(`import { ${name} } from './${kebab}';`);
    }
  }

  // Build component imports array
  const componentImports = [...qmlNgImports].sort();
  for (const name of [...childImports].sort()) {
    if (!componentImports.includes(name)) componentImports.push(name);
  }
  for (const name of [...componentDirectiveImports].sort()) {
    if (!componentImports.includes(name)) componentImports.push(name);
  }
  if (routes.length > 0 && !componentImports.includes('RouterOutlet')) {
    componentImports.push('RouterOutlet');
  }

  lines.push('@Component({');
  lines.push(`  selector: '${options.selector}',`);
  lines.push('  standalone: true,');
  lines.push(`  imports: [${componentImports.join(', ')}],`);
  lines.push('  template: `' + e + '`,');
  lines.push('})');
  lines.push(`export class ${options.className} {`);

  if (transform) {
    lines.push(...transform.bodyLines);
  } else {
    lines.push('  // (no controller source available)');
  }

  lines.push('}');

  // After the component class, export QML_ROUTES for use by main.ts bootstrap
  if (routes.length > 0) {
    const routeEntries = routes.map(r => {
      const rawPath = r.path.replace(/^\/+/, '');
      const routePath = rawPath === '' ? '' : rawPath;
      const ctrlName = routeSourceToControllerName(r.componentSource);
      const qmlTsPath = r.componentSource.replace(/\.qml$/, '.qml.ts');
      return `  { path: '${routePath}', loadComponent: () => import('./${qmlTsPath}').then(m => m.${ctrlName}Component) }`;
    }).join(',\n');
    lines.push('');
    lines.push(`export const QML_ROUTES = [\n${routeEntries}\n];`);
  }
  return lines.join('\n');
}

function routeSourceToControllerName(source: string): string {
  const base = source.split('/').pop()?.replace(/\.qml$/, '') || 'App';
  return base + 'Controller';
}

// ── Fallbacks ──

function compileWebBlocks(processed: import('./platform-directives.js').ProcessedTemplate, options: CompileOptions): CompiledComponent {
  const template = processed.htmlBlocks.map((b) => b.html.trim()).join('\n');
  const childImports = options.childRegistry
    ? new Set([...options.childRegistry.values()].map((info) => `${info.className}Component`))
    : new Set<string>();
  return {
    componentTs: buildComponent(template, options, new Set(['Component']), new Set(), [], childImports),
    template,
    styles: '',
    angularImports: ['Component'],
    qmlNgImports: [],
    hasRouter: false,
    routes: [],
    warnings: ['Pure HTML block compilation (no QML AST)'],
  };
}

function fallbackEmpty(options: CompileOptions): CompiledComponent {
  return {
    componentTs: buildComponent('<p>Empty component</p>', options, new Set(['Component']), new Set(), []),
    template: '<p>Empty component</p>',
    styles: '',
    angularImports: ['Component'],
    qmlNgImports: [],
    hasRouter: false,
    routes: [],
    warnings: ['No root QML element'],
  };
}
