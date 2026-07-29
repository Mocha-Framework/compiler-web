import type { Plugin, ResolvedConfig } from 'vite';
import { compileQmlToAngular } from './qml-to-angular.js';
import type { Platform, CompiledComponent } from './qml-to-angular.js';

export interface MochaAngularPluginOptions {
  target?: Platform;
  selectorPrefix?: string;
}

/**
 * Vite plugin that intercepts `.qml.ts` imports in Angular projects
 * and compiles them to Angular standalone components on the fly (JIT).
 *
 * Uses enforce: 'post' to run AFTER @analogjs/vite-plugin-angular's transform,
 * reading the ORIGINAL .qml.ts from disk so the Angular component output wins.
 * The output is compiled to JS via esbuild (lazy-imported) so Rollup can
 * parse it during vite build.
 */
export function mochaAngularPlugin(options: MochaAngularPluginOptions = {}): Plugin {
  const target: Platform = options.target ?? 'web';
  const selectorPrefix = options.selectorPrefix ?? 'app';

  return {
    name: '@mocha/compiler-web',
    enforce: 'post',

    configResolved(config: ResolvedConfig) {
      console.log(`[@mocha/compiler-web] Plugin active, target=${target}`);
    },

    async transform(code: string, id: string) {
      if (!id.endsWith('.qml.ts')) return null;

      console.log(`[@mocha/compiler-web] Transforming ${id}`);

      try {
        // Dynamic imports keep Node.js deps out of the Rollup bundle
        const fs = await import('node:fs');
        const esbuild = await import('esbuild');

        const original = fs.readFileSync(id, 'utf-8');
        const result = transformQmlTs(original, target, selectorPrefix);

        // Compile TypeScript output to JavaScript so Rollup can parse it
        const compiled = await esbuild.transform(result.componentTs, {
          loader: 'ts',
          format: 'esm',
          target: 'es2022',
        });

        return { code: compiled.code, map: null };
      } catch (e: any) {
        console.error(`[@mocha/compiler-web] Error transforming ${id}:`, e);
        return { code: `// [@mocha/compiler-web] Error: ${e.message}`, map: null };
      }
    },
  };
}

/**
 * Transform a `.qml.ts` source string into an Angular component module.
 *
 * Steps:
 * 1. Extract qml`...` template
 * 2. Extract controller class (inline it, strip @QMLComponent + runApp)
 * 3. Extract QProperty names from @qproperty decorators
 * 4. Extract method names from class body
 * 5. Compile to Angular component
 */
export function transformQmlTs(
  source: string,
  target: Platform,
  selectorPrefix: string
): CompiledComponent {
  const qmlMatch = extractQmlTemplate(source);
  if (!qmlMatch) {
    throw new Error('No qml`...` template found in .qml.ts file');
  }

  const className = extractControllerName(source);
  if (!className) {
    throw new Error('No controller class found in .qml.ts file');
  }

  const qpropertyNames = extractQPropertyNames(source);
  const methodNames = extractMethodNames(source, className);
  const controllerSource = extractControllerSource(source, className);

  const selector = `${selectorPrefix}-${className
    .replace(/([A-Z])/g, '-$1')
    .toLowerCase()
    .replace(/^-/, '')}`;

  return compileQmlToAngular(qmlMatch.template, {
    target,
    selector,
    className: `${className}Component`,
    controllerSource,
    controllerName: className,
    qpropertyNames,
    methodNames,
  });
}

// ── Extraction helpers ──

interface QmlTemplateMatch {
  template: string;
  startOffset: number;
  endOffset: number;
}

function extractQmlTemplate(source: string): QmlTemplateMatch | null {
  let i = 0;
  let latest: QmlTemplateMatch | null = null;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1] ?? '';

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      i++; continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i += 2; } else i++;
      continue;
    }
    if (inSingle) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === "'") inSingle = false;
      i++; continue;
    }
    if (inDouble) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '"') inDouble = false;
      i++; continue;
    }

    if (ch === '/' && next === '/') { inLineComment = true; i += 2; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i += 2; continue; }
    if (ch === "'") { inSingle = true; i++; continue; }
    if (ch === '"') { inDouble = true; i++; continue; }

    if (isQmlTagStart(source, i)) {
      const bt = findBacktick(source, i + 3);
      if (bt !== -1) {
        const parsed = parseBacktickTemplate(source, bt);
        latest = { template: parsed.content, startOffset: i, endOffset: parsed.endOffset };
        i = parsed.endOffset;
        continue;
      }
    }

    i++;
  }

  return latest;
}

function isQmlTagStart(source: string, offset: number): boolean {
  if (source.startsWith('qml', offset)) {
    const prev = offset === 0 ? '' : source[offset - 1];
    if (prev && /[\w$]/.test(prev)) return false;
    const next = source[offset + 3] ?? '';
    return next === '`' || /\s/.test(next);
  }
  return false;
}

function findBacktick(source: string, offset: number): number {
  let i = offset;
  while (i < source.length && /\s/.test(source[i])) i++;
  return source[i] === '`' ? i : -1;
}

function parseBacktickTemplate(
  source: string,
  backtickOffset: number
): { content: string; endOffset: number } {
  let i = backtickOffset + 1;
  let content = '';

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1] ?? '';

    if (ch === '\\') { content += source[i] + source[i + 1]; i += 2; continue; }
    if (ch === '$' && next === '{') { content += '${}'; i += 2; continue; }
    if (ch === '`') { return { content, endOffset: i + 1 }; }
    content += ch;
    i++;
  }

  throw new Error('Unterminated qml template literal');
}

function extractControllerName(source: string): string | null {
  const runAppMatch = source.match(/runApp\s*\(\s*(\w+)\s*\)/);
  if (runAppMatch) return runAppMatch[1];

  const classMatch = source.match(/@QMLComponent[\s\S]*?\bexport\s+class\s+(\w+)/);
  if (classMatch) return classMatch[1];

  const qobjMatch = source.match(/\bexport\s+class\s+(\w+)\s+extends\s+QObject\b/);
  if (qobjMatch) return qobjMatch[1];

  return null;
}

function extractControllerSource(source: string, className: string): string {
  const lines = source.split('\n');
  let classStart = -1;
  let classEnd: number | null = null;
  let braceDepth = 0;
  let foundClass = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!foundClass) {
      if (line.includes(`class ${className}`)) {
        classStart = i;
        foundClass = true;
        braceDepth = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
        if (braceDepth <= 0) braceDepth = 1;
      }
      continue;
    }

    braceDepth += (line.match(/{/g) || []).length;
    braceDepth -= (line.match(/}/g) || []).length;

    if (braceDepth <= 0) {
      classEnd = i + 1;
      break;
    }
  }

  if (classStart === -1) {
    return `class ${className} extends QObject {\n  constructor() { super(); }\n}`;
  }

  // If the brace matcher never closed (single-line `class Foo {}`), take
  // the rest of the file. Without this fallback, `slice(start, -1)`
  // silently drops the last line of the source.
  if (classEnd === null) classEnd = lines.length;

  const classLines = lines.slice(classStart, classEnd);
  let cleaned = classLines.join('\n');
  cleaned = cleaned.replace(/@QMLComponent\s*\([\s\S]*?\)\s*\n/, '');
  cleaned = cleaned.replace(/\bexport\s+class\b/, 'class');

  return cleaned.trim();
}

function extractQPropertyNames(source: string): string[] {
  const names: string[] = [];
  const re = /@qproperty\s+(\w+)/g;
  let m;
  while ((m = re.exec(source)) !== null) names.push(m[1]);
  return names;
}

function extractMethodNames(source: string, className: string): string[] {
  const names: string[] = [];
  const lines = source.split('\n');
  let inClass = false;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!inClass) {
      if (line.includes(`class ${className}`)) {
        inClass = true;
        braceDepth = (line.match(/{/g) || []).length - (line.match(/}/g) || []).length;
      }
      continue;
    }

    braceDepth += (line.match(/{/g) || []).length;
    braceDepth -= (line.match(/}/g) || []).length;
    if (braceDepth <= 0) break;

    const methodMatch = line.match(
      /^\s*(?:public\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*\w+\s*)?[{;]/
    );
    if (methodMatch) {
      const name = methodMatch[1];
      if (!['constructor', 'ngOnInit', 'ngOnDestroy', 'ngAfterViewInit', 'ngOnChanges', 'super'].includes(name) && !name.startsWith('_')) {
        names.push(name);
      }
    }
  }

  return names;
}
