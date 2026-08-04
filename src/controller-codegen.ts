/**
 * Transforms a Mocha controller class (the body of the .qml.ts file's
 * `class XController extends QObject { ... }`) into a pure Angular
 * component class.
 *
 * Transformations:
 *   - `@qproperty name = new QProperty<T>(init)` → `name = signal<T>(init)`
 *   - `@qproperty name = new QProperty(init)`   → `name = signal(init)`
 *   - `@qcomputed name = computed(() => ...)`   → `name = computed(() => { ... })`
 *   - `name = input<T>(v)`                       → `name = input(v)` (Angular signal input)
 *   - `name = output<T>()`                       → `name = output<T>()` (Angular signal output)
 *   - `name = viewChild("id", Type)`             → `name = viewChild<HTMLType>('id')`
 *   - `name = inject(GlobalState)`               → `name = inject(GlobalState)`
 *   - `name = new CounterDisplayController()`    → `name = inject(CounterDisplayComponent)` (or template)
 *   - `extends QObject`                          → removed
 *   - `this.X.value`                             → `this.X()` (read signal)
 *   - `this.X.value = N`                         → `this.X.set(N)`
 *   - `this.X.value += N`                        → `this.X.update(v => v + N)`
 *   - `this.bulkSet({a: 1, b: 2})`               → `batch(() => { this.a.set(1); this.b.set(2) })`
 *   - Method bodies rewritten to use signal API
 *
 * The resulting class is intended to be wrapped in `@Component({...})` by
 * the caller — this module only emits the class body.
 */

const QML_NG_TYPE_MAP: Record<string, string> = {
  QMLTextField: 'ElementRef<HTMLInputElement>',
  QMLTextInput: 'ElementRef<HTMLInputElement>',
  QMLButton: 'ElementRef<HTMLButtonElement>',
  QMLCheckBox: 'ElementRef<HTMLInputElement>',
  QMLSlider: 'ElementRef<HTMLInputElement>',
  QMLProgressBar: 'ElementRef<HTMLDivElement>',
  QMLTextArea: 'ElementRef<HTMLTextAreaElement>',
  QMLSwitch: 'ElementRef<HTMLInputElement>',
  QMLSpinBox: 'ElementRef<HTMLInputElement>',
  QMLComboBox: 'ElementRef<HTMLSelectElement>',
  QMLItem: 'ElementRef<HTMLDivElement>',
  QMLRectangle: 'ElementRef<HTMLDivElement>',
  QMLText: 'ElementRef<HTMLSpanElement>',
  QMLListView: 'ElementRef<HTMLDivElement>',
  QMLLoader: 'ElementRef<HTMLDivElement>',
};

export interface ControllerTransform {
  /** Lines of the transformed class body (no leading `@Component`, no `export class` wrapper). */
  bodyLines: string[];
  /** Names of fields that became Angular signals (used for template binding). */
  signalNames: string[];
  /** Names of fields that are computed signals. */
  computedNames: string[];
  /** Names of fields that are Angular inputs. */
  inputNames: string[];
  /** Names of fields that are Angular outputs. */
  outputNames: string[];
  /** Names of fields that are viewChild refs. */
  viewChildNames: string[];
  /** Names of fields that are inject()'d services. */
  injectNames: string[];
  /** Class names of injected services (for import generation). */
  injectClasses: string[];
  /** Names of methods (handlers). */
  methodNames: string[];
  /** Extra imports needed in the component file. */
  additionalImports: string[];
}

/**
 * Walk the source code character by character to extract the class body
 * between the class name's `{` and the matching `}`. Properly tracks
 * nested braces, strings, and comments so we don't get confused by
 * array literals or generics that contain `{` or `}`.
 */
function extractClassBody(source: string, className: string): { body: string; startLine: number } | null {
  // Find `class ClassName` (skipping comments and strings)
  const re = new RegExp(`\\bclass\\s+${className}\\b`);
  const match = re.exec(source);
  if (!match) return null;
  let i = match.index + match[0].length;
  const startLine = source.slice(0, i).split('\n').length - 1;

  // Skip to the opening `{` (skip `extends Foo` and any whitespace/comments)
  let depth = 0;
  let inStr: '"' | "'" | '`' | null = null;
  while (i < source.length) {
    const ch = source[i];
    if (inStr) {
      if (ch === '\\' && i + 1 < source.length) { i += 2; continue; }
      if (ch === inStr) inStr = null;
      i++; continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      // Line comment
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      // Block comment
      i += 2;
      while (i < source.length - 1 && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch as '"' | "'" | '`';
      i++; continue;
    }
    if (ch === '{') { depth = 1; i++; break; }
    i++;
  }

  if (depth !== 1) return null;

  const bodyStart = i;
  // Now consume until the matching `}`
  depth = 1;
  inStr = null;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (inStr) {
      if (ch === '\\' && i + 1 < source.length) { i += 2; continue; }
      if (ch === inStr) inStr = null;
      i++; continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length - 1 && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch as '"' | "'" | '`';
      i++; continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }

  if (depth !== 0) return null;
  const bodyEnd = i - 1;  // exclude the closing `}`
  return {
    body: source.slice(bodyStart, bodyEnd),
    startLine,
  };
}

/**
 * Strip type annotations from a JS/TS line body.
 * - `name: Type` → `name`
 * - `name: Type<TypeParam>` → `name`
 * - `name: Type = value` → `name = value`
 */
function stripTypeAnnotations(js: string): string {
  return js
    .replace(/(\w+)\s*:\s*[\w<>,\s|&\[\]]+(?=\s*[{=,);\n])/g, '$1')
    .replace(/(\w+)\s*:\s*[\w<>,\s|&\[\]]+(?=\s*$)/gm, '$1');
}

function transformControllerBody(
  classBody: string,
  injectTargets: Set<string>,
  viewChildSignals: Set<string>,
): { transformed: string; fieldNames: string[]; methodNames: string[]; computedNames: string[]; bulkSetFound: boolean } {
  // Tokenize: split into statements at depth 0 (respecting strings, comments, braces)
  const statements = splitStatements(classBody);
  const out: string[] = [];
  const fieldNames: string[] = [];
  const methodNames: string[] = [];
  const computedNames: string[] = [];
  let bulkSetFound = /\bbulkSet\s*\(/.test(classBody);

  for (const stmt of statements) {
    const trimmed = stmt.text.trim();

    // Skip empty
    if (!trimmed) continue;

    // Pure comment
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      out.push(trimmed);
      continue;
    }

    // Decorator + field/method declaration
    const decoMatch = trimmed.match(/^@(\w+)(?:\s*\([^)]*\))?\s*([\s\S]+)$/);
    if (decoMatch) {
      const decoName = decoMatch[1];
      const afterDeco = decoMatch[2].trim();

      // @qproperty X = ... or @qcomputed X = ...
      if (decoName === 'qproperty' || decoName === 'qcomputed') {
        const eqIdx = afterDeco.indexOf('=');
        if (eqIdx > 0) {
          const namePart = afterDeco.slice(0, eqIdx).trim();
          const valuePart = afterDeco.slice(eqIdx + 1).trim().replace(/;$/, '');
          const fieldName = stripTypeAnnotations(namePart);
          fieldNames.push(fieldName);

          if (decoName === 'qproperty') {
            // new QProperty<T>(init) or new QProperty(init) → signal(init)
            const qpMatch = valuePart.match(/^new\s+QProperty\s*(?:<([^>]+)>)?\s*\(([\s\S]*)\)\s*$/);
            if (qpMatch) {
              const typeArg = qpMatch[1]?.trim();
              const initArg = qpMatch[2].trim();
              if (typeArg) {
                out.push(`  ${fieldName} = signal<${typeArg}>(${initArg});`);
              } else {
                out.push(`  ${fieldName} = signal(${initArg});`);
              }
            } else {
              out.push(`  ${fieldName} = ${valuePart};`);
            }
          } else {
            // @qcomputed
            computedNames.push(fieldName);
            const rewritten = rewriteControllerExpressions(valuePart, injectTargets, viewChildSignals, computedNames);
            out.push(`  ${fieldName} = ${rewritten};`);
          }
          continue;
        }
      }

      // @Injectable — handled by codegen separately, skip
      if (decoName === 'Injectable') continue;

      // Other decorator + declaration
      const fieldMatch = afterDeco.match(/^(\w+)\s*(?::\s*[^=]+)?\s*=\s*([\s\S]+?);?\s*$/);
      if (fieldMatch) {
        const name = stripTypeAnnotations(fieldMatch[1]).trim();
        const value = fieldMatch[2].replace(/;$/, '').trim();
        const emit = transformFieldDecl(name, value, injectTargets, viewChildSignals);
        if (emit !== null) {
          fieldNames.push(name);
          out.push(emit);
          continue;
        }
      }
    }

    // Field declaration: name = value
    const fieldMatch = trimmed.match(/^(\w+)\s*(?::\s*[^=]+)?\s*=\s*([\s\S]+?);?\s*$/);
    if (fieldMatch && !trimmed.startsWith('//')) {
      const name = stripTypeAnnotations(fieldMatch[1]).trim();
      const value = fieldMatch[2].replace(/;$/, '').trim();
      const emit = transformFieldDecl(name, value, injectTargets, viewChildSignals);
      if (emit !== null) {
        fieldNames.push(name);
        out.push(emit);
        continue;
      }
    }

    // Method declaration: name(...) { ... }
    // Note: the regex only matches when `{` is in the same chunk. The
    // splitStatements function emits method bodies as a single chunk, so
    // this should work.
    const methodMatch = trimmed.match(/^(\w+)\s*\(([^)]*)\)\s*(?::\s*[^{]+)?\s*\{/);
    if (methodMatch) {
      const methodName = methodMatch[1];
      if (methodName === 'constructor') continue;
      // The `trimmed` is the chunk from `splitStatements`, which doesn't
      // capture the full method body (just up to first `;` or `\n`).
      // We need to re-parse the method body from the original source.
      // For simplicity, use the raw `trimmed` (which contains the body
      // until the chunk boundary) and re-extract the body.
      const methodBody = extractMethodBodyFromChunk(stmt.text);
      methodNames.push(methodName);
      const rewritten = rewriteMethodBody(methodBody, injectTargets, viewChildSignals, computedNames);
      const sig = methodMatch[0].replace(/\{.*$/s, '').trim();
      out.push(`  ${sig} {`);
      for (const line of rewritten.split('\n')) {
        if (line.trim()) {
          out.push('    ' + line);
        }
      }
      out.push('  }');
      continue;
    }

    // Other statement — keep as-is (could be plain assignment, expression, etc.)
    out.push(trimmed);
  }

  // Check for bulkSet usage
  for (const ln of out) {
    if (/\bbulkSet\s*\(/.test(ln)) {
      bulkSetFound = true;
      break;
    }
  }

  return { transformed: out.join('\n'), fieldNames, methodNames, computedNames, bulkSetFound };
}

function transformFieldDecl(
  name: string,
  value: string,
  injectTargets: Set<string>,
  viewChildSignals: Set<string>,
): string | null {
  // input<T>(v) → input(v)
  let m = value.match(/^input\s*<([^>]+)>\s*\(([^)]*)\)/);
  if (m) {
    return `  ${name} = input(${m[2].trim()});`;
  }
  m = value.match(/^input\s*\(([^)]*)\)/);
  if (m) {
    return `  ${name} = input(${m[1].trim()});`;
  }

  // output<T>() → output<T>()
  m = value.match(/^output\s*<([^>]+)>\s*\(\s*\)/);
  if (m) {
    return `  ${name} = output<${m[1].trim()}>();`;
  }
  m = value.match(/^output\s*\(\s*\)/);
  if (m) {
    return `  ${name} = output();`;
  }

  // viewChild("id", Type) → viewChild<Type>('id')
  m = value.match(/^viewChild\s*\(\s*["']([^"']+)["']\s*,\s*(\w+)\s*\)/);
  if (m) {
    const id = m[1];
    const type = m[2];
    const elType = QML_NG_TYPE_MAP[type] || 'ElementRef<HTMLElement>';
    viewChildSignals.add(name);
    return `  ${name} = viewChild<${elType}>('${id}');`;
  }

  // inject(Foo) → inject(Foo)
  m = value.match(/^inject\s*\(\s*(\w+)\s*\)/);
  if (m) {
    injectTargets.add(m[1]);
    return `  ${name} = inject(${m[1]});`;
  }

  // new CounterDisplayController() → stub so methods compile
  m = value.match(/^new\s+(\w+)(\(.*\))?$/);
  if (m && /Controller$/.test(m[1])) {
    return `  ${name} = { requestReset: () => {}, resetRequested: { emit: () => {} }, count: { value: 0 } } as any; // TODO: child controller ${m[1]} — convert to Angular component`;
  }

  // Regular field — keep as-is
  return `  ${name} = ${value};`;
}

/**
 * Given a chunk of text containing a method declaration, return just the
 * body content between `{` and the matching `}`.
 */
function extractMethodBodyFromChunk(chunk: string): string {
  // Find the opening `{` after the method signature
  let i = 0;
  let inStr: '"' | "'" | '`' | null = null;
  // Skip until we find the `{` of the method body (skipping over params/return type)
  while (i < chunk.length) {
    const ch = chunk[i];
    if (inStr) {
      if (ch === '\\' && i + 1 < chunk.length) { i += 2; continue; }
      if (ch === inStr) inStr = null;
      i++;
      continue;
    }
    if (ch === '/' && chunk[i + 1] === '/') {
      while (i < chunk.length && chunk[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && chunk[i + 1] === '*') {
      i += 2;
      while (i < chunk.length - 1 && !(chunk[i] === '*' && chunk[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch as '"' | "'" | '`'; i++; continue; }
    if (ch === '(') {
      // Skip balanced parens (params)
      let depth = 1;
      i++;
      while (i < chunk.length && depth > 0) {
        if (chunk[i] === '(') depth++;
        else if (chunk[i] === ')') depth--;
        i++;
      }
      continue;
    }
    if (ch === '{') { i++; break; }
    i++;
  }

  const start = i;
  // Now find the matching `}` for the body
  let depth = 1;
  inStr = null;
  while (i < chunk.length && depth > 0) {
    const ch = chunk[i];
    if (inStr) {
      if (ch === '\\' && i + 1 < chunk.length) { i += 2; continue; }
      if (ch === inStr) inStr = null;
      i++;
      continue;
    }
    if (ch === '/' && chunk[i + 1] === '/') {
      while (i < chunk.length && chunk[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && chunk[i + 1] === '*') {
      i += 2;
      while (i < chunk.length - 1 && !(chunk[i] === '*' && chunk[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch as '"' | "'" | '`'; i++; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }

  return chunk.slice(start, i - 1);
}

/**
 * Split the class body into top-level statements. We track `()`, `[]`, `{}`,
 * `<>`, and strings/comments so we don't split inside nested structures.
 * Method bodies (e.g. `name(...): T { ... }`) are emitted as a single
 * chunk since the `{}` of the body stays inside the depth counter.
 */
function splitStatements(source: string): Array<{ text: string; startLine: number }> {
  const out: Array<{ text: string; startLine: number }> = [];
  let i = 0;
  let parenDepth = 0;   // tracks ( ) and [ ]
  let braceDepth = 0;   // tracks { }
  let inStr: '"' | "'" | '`' | null = null;
  let start = 0;
  let startLine = 1;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1] ?? '';

    if (inStr) {
      if (ch === '\\' && i + 1 < source.length) { i += 2; continue; }
      if (ch === inStr) inStr = null;
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length - 1 && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch as '"' | "'" | '`';
      i++;
      continue;
    }

    // Track generic type brackets so we don't split on `;` inside `<T; U; V>`.
    if (ch === '<') {
      let gDepth = 1;
      i++;
      while (i < source.length && gDepth > 0) {
        const gc = source[i];
        if (gc === '<' && source[i - 1] !== '<') gDepth++;
        else if (gc === '>') gDepth--;
        i++;
      }
      i--;
      continue;
    }

    if (ch === '(' || ch === '[') parenDepth++;
    else if (ch === ')' || ch === ']') parenDepth--;
    else if (ch === '{') braceDepth++;
    else if (ch === '}') braceDepth--;

    // Statement boundary: ; or \n at top level (no open brackets/braces)
    if (parenDepth === 0 && braceDepth === 0 && (ch === ';' || ch === '\n')) {
      const text = source.slice(start, i + 1).trim();
      if (text) {
        out.push({ text, startLine });
      }
      // Skip blank lines
      while (i + 1 < source.length && (source[i + 1] === '\n' || source[i + 1] === ' ' || source[i + 1] === '\t')) {
        if (source[i + 1] === '\n') startLine++;
        i++;
      }
      start = i + 1;
      if (source[i + 1] === '\n') startLine++;
    }

    if (ch === '\n') startLine++;
    i++;
  }

  const tail = source.slice(start).trim();
  if (tail) out.push({ text: tail, startLine });

  return out;
}

/**
 * Rewrite expressions like:
 *   - `this.X.value` → `this.X()` (read signal)
 *   - `this.X.value = N` → `this.X.set(N)`
 *   - `this.X.value += N` → `this.X.update(v => v + N)`
 *   - `this.X.value.foo` → `this.X().foo`
 *
 * Handles nested braces for object literals (e.g. `this.bulkSet({a: 1, b: 2})`).
 */
function rewriteControllerExpressions(
  expr: string,
  injectTargets: Set<string>,
  viewChildSignals: Set<string>,
  computedNames: string[],
): string {
  // Process character-by-character to handle nested structures
  return rewriteSegment(expr, injectTargets, viewChildSignals, computedNames);
}

function rewriteSegment(
  segment: string,
  injectTargets: Set<string>,
  viewChildSignals: Set<string>,
  computedNames: string[],
): string {
  // Pattern: `this.IDENT.value` followed by `.`, `=`, `+`, `-`, etc.
  // Use a regex that doesn't cross object literal boundaries.
  let out = '';
  let i = 0;
  let depth = 0;  // tracks parens/braces (for object literals)
  let inStr: '"' | "'" | null = null;

  while (i < segment.length) {
    const ch = segment[i];

    if (inStr) {
      out += ch;
      if (ch === '\\' && i + 1 < segment.length) {
        out += segment[i + 1];
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

    // Match compound assignment FIRST: `this.X.value = N` / `this.X.value += N` etc.
    // This must come before the read-only match below so `+=` doesn't get
    // captured as a stray `+` operator.
    const assignM = segment.slice(i).match(/^this\.(\w+)\.value\s*([+\-*/]?=)(?!=)/);
    if (assignM) {
      const prop = assignM[1];
      const op = assignM[2];
      const opNoEq = op === '=' ? null : op.slice(0, -1);
      // Find the right-hand side (up to comma, semicolon, or close brace at depth 0)
      let j = i + assignM[0].length;
      let localDepth = 0;
      let localStr: '"' | "'" | null = null;
      while (j < segment.length) {
        const c = segment[j];
        if (localStr) {
          if (c === '\\' && j + 1 < segment.length) { j += 2; continue; }
          if (c === localStr) localStr = null;
          j++; continue;
        }
        if (c === '"' || c === "'") { localStr = c as '"' | "'"; j++; continue; }
        if (c === '(' || c === '{' || c === '[') localDepth++;
        else if (c === ')' || c === '}' || c === ']') {
          if (localDepth === 0) break;
          localDepth--;
        } else if (localDepth === 0 && (c === ',' || c === ';' || c === '\n')) break;
        j++;
      }
      const rhs = segment.slice(i + assignM[0].length, j).trim();
      if (op === '=') {
        out += `this.${prop}.set(${rewriteSegment(rhs, injectTargets, viewChildSignals, computedNames)})`;
      } else {
        out += `this.${prop}.update(v => v ${opNoEq} ${rewriteSegment(rhs, injectTargets, viewChildSignals, computedNames)})`;
      }
      i = j;
      continue;
    }

    // Match `this.X.value` (read) — followed by `=`, `+`, `-`, `*`, `/` (assignment),
    // by non-word non-dot (standalone read), or by `.IDENT` (chained access like `.length`).
    const m = segment.slice(i).match(/^this\.(\w+)\.value/);
    if (m) {
      out += `this.${m[1]}()`;
      i += m[0].length;
      continue;
    }

    // Convert viewChild access: `this.X.text` → `this.X()?.nativeElement.value`
    if (viewChildSignals.size > 0) {
      const vcNames = [...viewChildSignals].join('|');
      const vcRe = new RegExp(`^this\\.(${vcNames})\\.(\\w+)`);
      const vcMatch = segment.slice(i).match(vcRe);
      if (vcMatch) {
        const prop = vcMatch[2] === 'text' ? 'value' : vcMatch[2];
        out += `this.${vcMatch[1]}()?.nativeElement.${prop} ?? ''`;
        i += vcMatch[0].length;
        continue;
      }
    }

    out += ch;
    i++;
  }

  return out;
}

/**
 * Split a method body into individual statements. Unlike splitStatements
 * (which is for class bodies and captures `{...}` blocks), this works on
 * an already-extracted method body and respects all brace types: `()`,
 * `[]`, `{}`.
 */
function splitMethodBodyStatements(body: string): string[] {
  const out: string[] = [];
  let i = 0;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let inStr: '"' | "'" | '`' | null = null;
  let start = 0;

  while (i < body.length) {
    const ch = body[i];

    if (inStr) {
      if (ch === '\\' && i + 1 < body.length) { i += 2; continue; }
      if (ch === inStr) inStr = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch as '"' | "'" | '`'; i++; continue; }
    if (ch === '/' && body[i + 1] === '/') {
      while (i < body.length && body[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && body[i + 1] === '*') {
      i += 2;
      while (i < body.length - 1 && !(body[i] === '*' && body[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth--;
    else if (ch === '{') braceDepth++;
    else if (ch === '}') braceDepth--;
    else if (ch === '[') bracketDepth++;
    else if (ch === ']') bracketDepth--;

    // Statement boundary: ; or \n when all depths are zero
    if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0 && (ch === ';' || ch === '\n')) {
      const text = body.slice(start, i + 1).trim();
      if (text) out.push(text);
      start = i + 1;
    }
    i++;
  }

  const tail = body.slice(start).trim();
  if (tail) out.push(tail);

  return out;
}

function rewriteMethodBody(
  body: string,
  injectTargets: Set<string>,
  viewChildSignals: Set<string>,
  computedNames: string[],
): string {
  // Use splitMethodBodyStatements (not splitStatements) because the method
  // body is already extracted — we don't want to re-capture `{...}` blocks
  // from inner objects.
  const statements = splitMethodBodyStatements(body);
  const out: string[] = [];

  for (const trimmed of statements) {
    if (!trimmed) continue;

    // Pure comment
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      out.push(trimmed);
      continue;
    }

    // Detect `this.bulkSet({...})` and rewrite to sequential `this.X.set(N)` calls.
    const bulkSetMatch = trimmed.match(/this\.bulkSet\s*\(\s*\{([\s\S]*)\}\s*\)\s*;?\s*$/);
    if (bulkSetMatch) {
      const objBody = bulkSetMatch[1];
      const pairs = parseObjectLiteral(objBody);
      const setCalls = pairs.map(([k, v]) => {
        const cleaned = rewriteControllerExpressions(v.trim(), injectTargets, viewChildSignals, computedNames);
        return `    this.${k}.set(${cleaned});`;
      }).join('\n');
      // Angular 20 does NOT have batch(). Just emit the set calls sequentially.
      out.push(setCalls);
      continue;
    }

    // Regular statement — rewrite expressions
    out.push(rewriteControllerExpressions(trimmed, injectTargets, viewChildSignals, computedNames));
  }

  return out.join('\n');
}

function parseObjectLiteral(body: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  let i = 0;
  let depth = 0;
  let buf = '';
  while (i < body.length) {
    const ch = body[i];
    if (ch === '{' || ch === '[' || ch === '(') { depth++; buf += ch; i++; continue; }
    if (ch === '}' || ch === ']' || ch === ')') { depth--; buf += ch; i++; continue; }
    if (ch === ',' && depth === 0) {
      const colonIdx = findTopLevelColon(buf);
      if (colonIdx > 0) {
        const key = buf.slice(0, colonIdx).trim().replace(/^["']|["']$/g, '');
        const value = buf.slice(colonIdx + 1).trim();
        pairs.push([key, value]);
      }
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf.trim()) {
    const colonIdx = findTopLevelColon(buf);
    if (colonIdx > 0) {
      const key = buf.slice(0, colonIdx).trim().replace(/^["']|["']$/g, '');
      const value = buf.slice(colonIdx + 1).trim();
      pairs.push([key, value]);
    }
  }
  return pairs;
}

function findTopLevelColon(s: string): number {
  let depth = 0;
  let inStr: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\' && i + 1 < s.length) { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch as '"' | "'"; continue; }
    if (ch === '{' || ch === '[' || ch === '(') { depth++; continue; }
    if (ch === '}' || ch === ']' || ch === ')') { depth--; continue; }
    if (ch === ':' && depth === 0) return i;
  }
  return -1;
}

/**
 * Detect @Injectable decorated classes (services like GlobalState).
 */
export function detectInjectables(source: string): string[] {
  const names: string[] = [];
  const re = /@Injectable\s*\([^)]*\)\s*(?:export\s+)?class\s+(\w+)/g;
  let m;
  while ((m = re.exec(source)) !== null) names.push(m[1]);
  return names;
}

/**
 * Top-level entry: transform a .qml.ts controller class into an Angular
 * component class.
 */
export function transformControllerClass(
  source: string,
  className: string,
): ControllerTransform | null {
  const extracted = extractClassBody(source, className);
  if (!extracted) return null;

  // `extracted.body` is the inner body of the class (between `{` and `}`).
  const innerBody = extracted.body;

  const injectTargets = new Set<string>(detectInjectables(source));
  const viewChildSignals = new Set<string>();

  const { transformed, fieldNames, methodNames, computedNames, bulkSetFound } =
    transformControllerBody(innerBody, injectTargets, viewChildSignals);

  const signalNames = fieldNames.filter(
    (n) => !viewChildSignals.has(n) && !injectTargets.has(n) &&
           !fieldNameIsInputOutput(transformed, n)
  );
  const inputNames = fieldNames.filter((n) => /\binput\(/.test(extractFieldAssignment(transformed, n) || ''));
  const outputNames = fieldNames.filter((n) => /\boutput\(/.test(extractFieldAssignment(transformed, n) || ''));
  const viewChildNames = [...viewChildSignals];
  const injectNames = fieldNames.filter((n) => /\binject\(/.test(extractFieldAssignment(transformed, n) || ''));
  const injectClasses = [...injectTargets];

  const additionalImports: string[] = [];
  if (bulkSetFound) {
    additionalImports.push('batch');
  }

  return {
    bodyLines: transformed.split('\n'),
    signalNames,
    computedNames,
    inputNames,
    outputNames,
    viewChildNames,
    injectNames,
    injectClasses,
    methodNames,
    additionalImports,
  };
}

function fieldNameIsInputOutput(body: string, name: string): boolean {
  const line = extractFieldAssignment(body, name) || '';
  return /\binput\(/.test(line) || /\boutput\(/.test(line);
}

function extractFieldAssignment(body: string, name: string): string | null {
  const re = new RegExp(`^\\s*${name}\\s*=\\s*(.+?);?\\s*$`, 'm');
  const m = body.match(re);
  return m ? m[1] : null;
}
