/**
 * Static-analysis helpers for extracting child controller metadata from
 * `.qml.ts` source files. Used by the codegen + vite plugin to know
 * what input/output/model fields each child controller exposes, so
 * the parent QML → Angular template emission can produce the right
 * `[name]`, `[(name)]`, `(nameChange)` bindings.
 *
 * These helpers operate on raw source text — they do not require the
 * TypeScript file to be imported or its decorators to run.
 */

export interface ChildControllerInfo {
  /** Class name, e.g. `ChildController`. */
  className: string;
  /** QML tag name, e.g. `Child` (via `as` option or auto-derived). */
  tag: string;
  /** Path of the source file, for debugging. */
  sourcePath?: string;
  /** Names of `input()` fields. */
  inputNames: string[];
  /** Names of `output()` fields. */
  outputNames: string[];
  /** Names of `model()` fields (two-way). */
  modelNames: string[];
  /** Names of `@qproperty` fields (also surfaced as `[name]` bindings). */
  qpropertyNames: string[];
}

const CONTROLLER_SUFFIX = "Controller";

/**
 * Derive a tag name from a class name, mirroring `@QMLComponent`'s
 * default behavior.
 */
export function deriveTagName(className: string): string {
  if (className.endsWith(CONTROLLER_SUFFIX)) {
    return className.slice(0, -CONTROLLER_SUFFIX.length);
  }
  return className;
}

/**
 * Convert a tag name to a kebab-case Angular selector.
 * `Child` → `app-child`, `MyCard` → `app-my-card`.
 */
export function tagToSelector(tag: string, prefix = "app"): string {
  const kebab = tag
    .replace(/([A-Z])/g, "-$1")
    .toLowerCase()
    .replace(/^-/, "");
  return `${prefix}-${kebab}`;
}

/**
 * Extract the `@QMLComponent({ as: "..." })` tag override from a source
 * file. Returns `null` if no decorator is found, or the explicit `as`
 * value if present.
 *
 * Uses a brace-counting scanner to handle nested objects (e.g. `qml`
 * template literals that contain `{` and `}`).
 */
export function extractQmlComponentAs(source: string): string | null | undefined {
  const start = source.indexOf("@QMLComponent");
  if (start === -1) return null;

  // Find the opening `{` of the decorator argument object.
  const openBrace = source.indexOf("{", start);
  if (openBrace === -1) return null;

  // Walk forward, counting braces (respecting strings, comments, backticks).
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;
  let endIndex = -1;
  for (let i = openBrace; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1] ?? "";

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inBacktick) {
      if (ch === "\\") { i++; continue; }
      if (ch === "`") inBacktick = false;
      continue;
    }
    if (inSingle) {
      if (ch === "\\") { i++; continue; }
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") { i++; continue; }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "/" && next === "/") { inLineComment = true; i++; continue; }
    if (ch === "/" && next === "*") { inBlockComment = true; i++; continue; }
    if (ch === "`") { inBacktick = true; continue; }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        endIndex = i;
        break;
      }
    }
  }

  if (endIndex === -1) return null;
  const block = source.slice(openBrace, endIndex + 1);
  const asMatch = block.match(/\bas\s*:\s*["']([^"']+)["']/);
  return asMatch ? asMatch[1] : undefined;
}

/**
 * Extract the controller class name (the one extending QObject / QmlInit)
 * from a source file. Returns `null` if no class is found.
 */
export function extractClassName(source: string): string | null {
  const m = source.match(/class\s+(\w+)\s+extends\s+QObject/);
  return m ? m[1] : null;
}

/**
 * Extract `input()` field names. Matches:
 *   `name = input<string>("default");`
 *   `age = input(0);`
 */
export function extractInputNames(source: string): string[] {
  const names: string[] = [];
  // Pattern: name = input(...);
  const re = /^\s*(\w+)\s*=\s*input\s*[<(]/gm;
  let m;
  while ((m = re.exec(source)) !== null) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/**
 * Extract `output()` field names. Matches:
 *   `clicked = output<{...}>();`
 *   `saved = output();`
 */
export function extractOutputNames(source: string): string[] {
  const names: string[] = [];
  const re = /^\s*(\w+)\s*=\s*output\s*[<(]/gm;
  let m;
  while ((m = re.exec(source)) !== null) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/**
 * Extract `model()` field names. Matches:
 *   `value = model<string>("");`
 *   `count = model(0);`
 */
export function extractModelNames(source: string): string[] {
  const names: string[] = [];
  const re = /^\s*(\w+)\s*=\s*model\s*[<(]/gm;
  let m;
  while ((m = re.exec(source)) !== null) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/**
 * Extract `@qproperty` field names. Same as `extractQPropertyNames` in
 * vite-plugin.ts; re-implemented here to keep the codegen module
 * self-contained.
 */
export function extractQPropertyNamesFromSource(source: string): string[] {
  const names: string[] = [];
  const re = /@qproperty\s+(\w+)/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/**
 * Extract child controller info from a `.qml.ts` source file.
 * Returns `null` if no `@QMLComponent` is found.
 */
export function extractChildControllerInfo(
  source: string,
  sourcePath?: string
): ChildControllerInfo | null {
  const asOpt = extractQmlComponentAs(source);
  if (asOpt === null) return null; // No @QMLComponent

  const className = extractClassName(source);
  if (!className) return null;

  // Compute the tag name:
  //   explicit `as` option wins
  //   else derive from class name
  const tag = asOpt ?? deriveTagName(className);

  return {
    className,
    tag,
    sourcePath,
    inputNames: extractInputNames(source).sort(),
    outputNames: extractOutputNames(source).sort(),
    modelNames: extractModelNames(source).sort(),
    qpropertyNames: extractQPropertyNamesFromSource(source).sort(),
  };
}

/**
 * Build a tag → ChildControllerInfo registry from a list of source
 * files. Returns a Map keyed by tag name (e.g. `Child`).
 */
export function buildChildRegistry(
  sources: Array<{ source: string; path?: string }>
): Map<string, ChildControllerInfo> {
  const registry = new Map<string, ChildControllerInfo>();
  for (const { source, path } of sources) {
    const info = extractChildControllerInfo(source, path);
    if (info) {
      registry.set(info.tag, info);
    }
  }
  return registry;
}
