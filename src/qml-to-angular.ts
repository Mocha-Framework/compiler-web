import { QmlAstParser } from '@mocha/qml/ast';
import type { QmlElement, QmlDocument } from '@mocha/qml/ast';
import { preprocessPlatformDirectives } from './platform-directives.js';
import type { Platform, HtmlBlock } from './platform-directives.js';
import { getElementDef, hasQmlNgComponent } from './element-mapper.js';
import { walkChildComponent, type ChildBindingsContext } from './child-component-codegen.js';
import type { ChildControllerInfo } from './child-component-info.js';

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
}

function isWindow(el: QmlElement): boolean {
  return el.tag === 'ApplicationWindow' || el.tag === 'Window';
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
      const attrs = formatAttrsSimple(el, '');
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
    const attrs = formatAttrsFallback(props, el);
    const tag = def.tag;
    const content = childrenHtml || extractStaticText(el.body);
    if (!content) return pad + `<${tag}${attrs}></${tag}>`;
    if (!childrenHtml) return pad + `<${tag}${attrs}>${content}</${tag}>`;
    return pad + `<${tag}${attrs}>\n${content}\n${pad}</${tag}>`;
  }

  ctx.warnings.push(`Unknown QML element: ${el.tag}, rendered as <div>`);
  const attrs = formatAttrsFallback(props, el);
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

function formatAttrsSimple(el: QmlElement, _baseClass: string): string {
  const props = parseQmlProps(el.body);
  if (props.length === 0) return '';
  const parts: string[] = [];
  for (const [key, value, wasQuoted] of props) {
    // Filter out QML-internal props not relevant to Angular
    if (key.startsWith('anchors.') || key === 'id' || key === 'x' || key === 'y' || key === 'z' || key === 'width' || key === 'height') continue;
    if (key === 'visible' || key === 'enabled' || key === 'clip' || key === 'opacity') continue;

    // Convert QML dotted properties to camelCase (font.pixelSize → fontPixelSize)
    const mappedKey = key.replace(/\.([a-zA-Z])/g, (_, c) => c.toUpperCase());

    const binding = mapBindingSimple(mappedKey, value, wasQuoted);
    if (binding) parts.push(binding);
  }
  return parts.length > 0 ? ' ' + parts.join(' ') : '';
}

function mapBindingSimple(key: string, value: string, wasQuoted: boolean = false): string | null {
  // Translate controller.X.value → X() anywhere in the expression
  const translatedValue = value.replace(/controller\.(\w+)\.value/g, '$1()');
  // Also translate trailing controller.X → X() (when not followed by .)
  const fullyTranslated = translatedValue.replace(/controller\.(\w+)(?!\.)/g, '$1()');

  // Event handlers: QML onClicked → Angular (clicked)
  if (key.startsWith('on') && /^on[A-Z]/.test(key)) {
    const eventName = key.slice(2);
    const lc = eventName.charAt(0).toLowerCase() + eventName.slice(1);
    const fn = fullyTranslated.match(/^(\w+)\(/);
    if (fn) return `(${lc})="ctrl.${fn[1]}($event)"`;
    const svc = value.match(/^(\w+)\.(\w+)\(/);
    if (svc) return `(${lc})="ctrl.callRoot('${svc[1]}', '${svc[2]}')"`;
    return `(${lc})="${fullyTranslated}"`;
  }

  // Controller binding: controller.prop[.value] → [prop]="prop()"
  if (value.startsWith('controller.')) {
    const m = value.match(/^controller\.(\w+)(?:\.value)?$/);
    if (m) return `[${key}]="${m[1]}()"`;
    return `[${key}]="${fullyTranslated}"`;
  }

  // i18n
  if (value.startsWith('MochaI18n.')) {
    let expr = value.replace(/^MochaI18n\./, '');
    expr = expr.replace(/controller\.(\w+)\.value/g, (_, n) => `${n}()`);
    expr = expr.replace(/controller\.(\w+)\b/g, (_, n) => `${n}()`);
    if (key === 'text' || key === 'title' || key === 'label') {
      return `[innerText]="i18n(${expr})"`;
    }
    return `[${key}]="i18n(${expr})"`;
  }

  // Service access
  const get = value.match(/^(\w+)\.get\("(\w+)"\)$/);
  if (get) return `[${key}]="${get[1]}.${get[2]}"`;

  // Theme reference
  if (value.startsWith('Theme.')) return `[${key}]="${value}"`;

  // Static values
  if (value === 'true') return key;
  if (value === 'false') return `[${key}]="false"`;
  if (/^-?\d+(\.\d+)?$/.test(value)) return `[${key}]="${value}"`;

  // Check if value contains quotes that would break HTML attribute syntax
  const hasDoubleQ = fullyTranslated.includes('"');
  const hasSingleQ = fullyTranslated.includes("'");
  if (hasDoubleQ && !hasSingleQ) return `[${key}]='${fullyTranslated}'`;
  if (hasDoubleQ && hasSingleQ) return `[${key}]="${fullyTranslated.replace(/"/g, '&quot;')}"`;

  // Pass through as string attribute
  // SAFETY NET: if the original QML value was a quoted string literal, wrap
  // it in quotes so Angular parses it as a string instead of a JS identifier
  // (e.g. `text: "About"` → `[innerText]="'About'"`, not `[innerText]="About"`).
  if (wasQuoted) {
    const escaped = fullyTranslated.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `[${key}]="'${escaped}'"`;
  }
  return `[${key}]="${fullyTranslated}"`;
}

// ── Old fallback formatter (for non-qml-ng elements) ──

function formatAttrsFallback(props: [string, string, boolean][], _el: QmlElement): string {
  if (props.length === 0) return '';
  const parts: string[] = [];
  for (const [key, value, wasQuoted] of props) {
    if (shouldSkip(key)) continue;
    if (key === 'id') continue;
    if (key === 'text' && !value.startsWith('controller.') && !value.includes('(')) continue;
    const binding = mapBindingFallback(key, value, wasQuoted);
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

function mapBindingFallback(key: string, value: string, wasQuoted: boolean = false): string | null {
  // Translate controller.X.value → X() and controller.X → X()
  const fullyTranslated = value
    .replace(/controller\.(\w+)\.value/g, '$1()')
    .replace(/controller\.(\w+)(?!\.)/g, '$1()');

  if (key.startsWith('on') && /^on[A-Z]/.test(key)) {
    const event = mapEvent(key);
    const fn = fullyTranslated.match(/^(\w+)\(/);
    if (fn) return `${event}="ctrl.${fn[1]}($event)"`;
    const svc = value.match(/^(\w+)\.(\w+)\(/);
    if (svc) return `${event}="ctrl.callRoot('${svc[1]}', '${svc[2]}')"`;
    return `${event}="${fullyTranslated}"`;
  }

  if (value.startsWith('controller.')) {
    const m = value.match(/^controller\.(\w+)(?:\.value)?$/);
    if (m) {
      const prop = m[1];
      return key === 'text' || key === 'label' || key === 'title'
        ? `[innerText]="${prop}()"`
        : `[${key}]="${prop}()"`;
    }
    return key === 'text' || key === 'label' || key === 'title'
      ? `[innerText]="${fullyTranslated}"`
      : `[${key}]="${fullyTranslated}"`;
  }

  if (value.startsWith('MochaI18n.')) {
    let expr = value.replace(/^MochaI18n\./, '');
    expr = expr.replace(/controller\.(\w+)\.value/g, (_, n) => `${n}()`);
    expr = expr.replace(/controller\.(\w+)\b/g, (_, n) => `${n}()`);
    return `[innerText]="i18n(${expr})"`;
  }

  const get = value.match(/^(\w+)\.get\("(\w+)"\)$/);
  if (get) return `[${key}]="${get[1]}.${get[2]}"`;

  const method = value.match(/^(\w+)\.(\w+)\(/);
  if (method && method[1] !== 'MochaI18n' && method[1] !== 'Theme') {
    const event = mapEvent(key.startsWith('on') ? key : `on${key[0].toUpperCase() + key.slice(1)}`);
    return `${event}="ctrl.callRoot('${method[1]}', '${method[2]}')"`;
  }

  if (value.startsWith('Theme.')) return `[${key}]="${value}"`;
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

  lines.push(`import { ${[...angularImports].join(', ')} } from '@angular/core';`);

  if (qmlNgImports.size > 0) {
    const names = [...qmlNgImports].sort();
    lines.push(`import { ${names.join(', ')} } from '@mocha/qml-ng';`);
  }

  lines.push(`import { toQSignal } from '@mocha/compiler-web';`);
  lines.push(`import { QObject, QProperty } from '@mocha/core';`);
  if (options.qpropertyNames.length > 0) {
    lines.push(`import { qproperty } from '@mocha/core';`);
  }

  // Emit a single `@angular/router` import containing RouterOutlet (when routes
  // were extracted) plus any RouterLink/RouterLinkActive referenced in the QML.
  const routerImportNames = new Set<string>();
  if (routes.length > 0) routerImportNames.add('RouterOutlet');
  for (const name of routerImports) routerImportNames.add(name);
  if (routerImportNames.size > 0) {
    lines.push(`import { ${[...routerImportNames].sort().join(', ')} } from '@angular/router';`);
  }

  const cleanControllerSource = stripTypeAnnotations(stripDecoLines(options.controllerSource));

  lines.push('');
  lines.push(cleanControllerSource);
  lines.push('');

  // Build component imports array (qml-ng components + child components + RouterOutlet
  // + Angular directives/pipes the template references, e.g. RouterLink).
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
  lines.push(`  ctrl = new ${options.controllerName}();`);
  lines.push('');

  for (const n of options.qpropertyNames) {
    lines.push(`  ${n} = toQSignal(this.ctrl.${n});`);
  }

  lines.push('');
  for (const n of options.methodNames) {
    lines.push(`  ${n}(...args: any[]): any { return (this.ctrl as any)[${JSON.stringify(n)}](...args); }`);
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
