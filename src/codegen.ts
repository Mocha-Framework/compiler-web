/**
 * File-system codegen: walk a directory of `.qml.ts` files and emit Angular
 * standalone components (component.ts + component.html) under an output dir,
 * mirroring the source layout, plus an aggregated `qml-routes.ts`.
 *
 * This is the up-front codegen half of the new web pipeline. The QML source
 * stays in `src/` and remains the single source of truth; the Angular
 * output goes to a gitignored directory (e.g. `.mocha/web/`) and is fed
 * directly to a standard Angular AOT bundler via Vite (no on-the-fly
 * transform plugin, no Analog JIT runtime).
 */

import {
  readFile,
  writeFile,
  readdir,
  mkdir,
  stat,
  rm,
} from "node:fs/promises";
import {
  resolve,
  relative,
  join,
  dirname,
  basename,
  extname,
} from "node:path";
import { createHash } from "node:crypto";

import { transformQmlTs } from "./vite-plugin.js";
import type { CompiledComponent } from "./qml-to-angular.js";

export interface CodegenOptions {
  srcDir: string;
  outDir: string;
  /** Selector prefix for component selectors. Default: 'app'. */
  prefix?: string;
  /** Verbose logging. */
  verbose?: boolean;
  /**
   * When true, emit a complete web app scaffold in `outDir`:
   *   - `index.html` with the root component selector
   *   - `main.ts` with `bootstrapApplication` + `provideZonelessChangeDetection`
   *   - `global-state.ts` (if any `@Injectable` services were detected)
   *   - `package.json` with `"type": "module"`
   */
  webBootstrap?: boolean;
  /**
   * The root component selector (e.g. `app-app-controller`). Used by the
   * generated `index.html` host element. Defaults to finding the App.*.qml.ts
   * file and computing its selector.
   */
  rootSelector?: string;
  /**
   * The root component class name (e.g. `AppControllerComponent`). Used by
   * the generated `main.ts` to bootstrap the application.
   */
  rootClassName?: string;
  /**
   * Path to the generated `qml-routes.ts` (relative to outDir). Defaults to
   * `./qml-routes`. Used by `main.ts` to wire `provideRouter`.
   */
  routesImport?: string;
}

export interface GeneratedRoute {
  path: string;
  loadFrom: string;
  componentClass: string;
}

export interface CodegenResult {
  filesWritten: string[];
  routes: GeneratedRoute[];
  warnings: string[];
  skipped: string[];
}

const DEFAULT_PREFIX = "app";

export async function generateWebProject(
  opts: CodegenOptions
): Promise<CodegenResult> {
  const srcDir = resolve(process.cwd(), opts.srcDir);
  const outDir = resolve(process.cwd(), opts.outDir);
  const prefix = opts.prefix ?? DEFAULT_PREFIX;
  const verbose = !!opts.verbose;
  const webBootstrap = opts.webBootstrap ?? true;

  if (!(await safeStat(srcDir))) {
    return { filesWritten: [], routes: [], warnings: [], skipped: [] };
  }

  await mkdir(outDir, { recursive: true });

  const sources = await collectQmlTs(srcDir);
  const result: CodegenResult = {
    filesWritten: [],
    routes: [],
    warnings: [],
    skipped: [],
  };

  // Track injectables (services like GlobalState) for web-bootstrap generation
  const injectables: Array<{ className: string; fileName: string; controllerSource: string }> = [];

  for (const absSrc of sources) {
    const source = await readFile(absSrc, "utf-8");
    const hash = sha256(source);
    const cachePath = `${absSrc}.mochacache`;

    // Detect @Injectable classes for service scaffolding
    const injectableMatch = source.match(/@Injectable[\s\S]*?export\s+class\s+(\w+)/);
    if (injectableMatch) {
      const className = injectableMatch[1];
      // Generate the service file (kebab-cased name, .ts extension)
      const baseName = relative(srcDir, absSrc).replace(/\.qml\.ts$/, "").replace(/\.ts$/, "");
      const lastSegment = baseName.split(/[\\/]/).pop()!;
      const serviceFileName = lastSegment
        .replace(/([A-Z])/g, '-$1')
        .toLowerCase()
        .replace(/^-/, '') + '.ts';
      injectables.push({
        className,
        fileName: serviceFileName,
        controllerSource: source,
      });
    }

    const cached = await readCache(cachePath);
    if (cached && cached.hash === hash) {
      // Cache hit: skip the heavy transform, but RESTORE the routes
      // extracted from this file on a previous run. Without this the
      // aggregated `qml-routes.ts` would be overwritten with an empty
      // array on every re-run that hits cache.
      if (cached.routes.length > 0) {
        result.routes.push(...cached.routes);
      }
      result.skipped.push(absSrc);
      continue;
    }

    let compiled: CompiledComponent;
    try {
      // Skip plain .ts files that don't have a qml template — they're services
      if (!absSrc.endsWith(".qml.ts")) {
        // Services are handled separately in the bootstrap pass
        continue;
      }
      compiled = transformQmlTs(source, "web", prefix);
    } catch (e: any) {
      result.warnings.push(
        `[codegen] ${relative(process.cwd(), absSrc)}: ${e.message}`
      );
      continue;
    }

    const relFromSrc = relative(srcDir, absSrc);
    const baseNameNoExt = relFromSrc.replace(/\.qml\.ts$/, "");
    const pascal = baseNameNoExt.split(/[\\/]/).pop()!;
    const outDirForFile = dirname(join(outDir, baseNameNoExt));
    await mkdir(outDirForFile, { recursive: true });

    const kebab = pascalToKebab(pascal);
    const outTs = join(outDirForFile, `${kebab}.component.ts`);
    const outHtml = join(outDirForFile, `${kebab}.component.html`);

    // Rewrite the loadComponent() dynamic imports so they point at the
    // generated Angular component files (not the .qml.ts sources),
    // then strip the per-file QML_ROUTES export since the canonical
    // routes file (`qml-routes.ts`) is what's used at runtime.
    let componentTs = rewriteRouteImports(compiled.componentTs);
    componentTs = stripEmbeddedRoutes(componentTs);

    const fileRoutes: GeneratedRoute[] = [];
    if (compiled.routes && compiled.routes.length > 0) {
      for (const r of compiled.routes) {
        // `r.componentSource` is the literal string from QML's
        // `source: Qt.resolvedUrl("views/Home.qml")` — relative to the App.qml.ts
        // file's directory (which is `src/`, mirroring `.mocha/web/`).
        const qmlSource = r.componentSource;
        const noExt = qmlSource.replace(/\.qml$/, "").replace(/^\.\//, "");
        const segments = noExt.split(/[\\/]/).filter(Boolean);
        const targetPascal = segments.pop();
        if (!targetPascal) continue;
        const dirSegments = segments; // e.g. ['views']
        const rel =
          (dirSegments.length ? dirSegments.join("/") + "/" : "") +
          pascalToKebab(targetPascal) +
          ".component.js";
        const loadFrom = rel.startsWith(".") ? rel : "./" + rel;
        const routePath = r.path.replace(/^\/+/, "");
        const routeEntry: GeneratedRoute = {
          path: routePath === "/" ? "" : routePath,
          loadFrom,
          componentClass: `${targetPascal}ControllerComponent`,
        };
        fileRoutes.push(routeEntry);
        result.routes.push(routeEntry);
      }
    }

    await writeFile(outTs, componentTs, "utf-8");
    if (compiled.template && compiled.template.trim()) {
      await writeFile(outHtml, compiled.template, "utf-8");
    }
    // Persist {hash, routes} so a future cache hit can restore routes.
    await writeCache(cachePath, hash, fileRoutes);

    result.filesWritten.push(outTs, outHtml);
    result.warnings.push(
      ...compiled.warnings.map((w) => `[${relative(process.cwd(), absSrc)}] ${w}`)
    );

    if (verbose) {
      console.log(
        `[codegen] ${relative(process.cwd(), absSrc)} → ${relative(
          process.cwd(),
          outTs
        )}`
      );
    }
  }

  // Always (re)emit the aggregated routes file whenever any .qml.ts declared
  // routes. Even when all inputs are cached, downstream files may reference
  // this entry, so write it idempotently.
  const routesFile = join(outDir, "qml-routes.ts");
  const routesCode = generateRoutesModule(result.routes);
  await writeFile(routesFile, routesCode, "utf-8");
  result.filesWritten.push(routesFile);

  // Generate service files for each @Injectable (always, not just webBootstrap)
  const serviceImports: string[] = [];
  for (const inj of injectables) {
    const serviceTs = await generateServiceFile(inj);
    const servicePath = join(outDir, inj.fileName);
    await writeFile(servicePath, serviceTs, "utf-8");
    result.filesWritten.push(servicePath);
    const importPath = "./" + inj.fileName.replace(/\.ts$/, "");
    serviceImports.push(`import { ${inj.className} } from '${importPath}';`);
  }

  // Web bootstrap: generate index.html, main.ts, and services.
  if (webBootstrap) {
    const rootSelector = opts.rootSelector ?? inferRootSelector(sources, prefix);
    const rootClassName = opts.rootClassName ?? inferRootClassName(sources);
    const routesImport = opts.routesImport ?? "./qml-routes";

    // Write a minimal Vite config that tells Vite to handle TypeScript with legacy decorators
    const viteConfig = 'import { defineConfig } from \'vite\';\n' +
      'export default defineConfig({\n' +
      '  resolve: {\n' +
      '    extensions: [\'.ts\', \'.mjs\', \'.js\'],\n' +
      '  },\n' +
      '  esbuild: {\n' +
      '    target: \'es2022\',\n' +
      '    tsconfigRaw: JSON.stringify({\n' +
      '      compilerOptions: {\n' +
      '        experimentalDecorators: true,\n' +
      '        useDefineForClassFields: false,\n' +
      '      },\n' +
      '    }),\n' +
      '  },\n' +
      '});\n';
    await writeFile(join(outDir, "vite.config.ts"), viteConfig, "utf-8");
    result.filesWritten.push(join(outDir, "vite.config.ts"));

    const mainTs = generateMainTs({
      rootClassName,
      routesImport,
      serviceImports,
      hasRoutes: result.routes.length > 0,
    });
    await writeFile(join(outDir, "main.ts"), mainTs, "utf-8");
    result.filesWritten.push(join(outDir, "main.ts"));

    // package.json (minimal, for ESM)
    const packageJson = JSON.stringify({ type: "module" }, null, 2) + "\n";
    await writeFile(join(outDir, "package.json"), packageJson, "utf-8");
    result.filesWritten.push(join(outDir, "package.json"));
  }

  // After writing all .ts files, the Angular CLI handles AOT compilation.
  // No need for esbuild post-compilation — ng serve / ng build do that.

  return result;
}

/**
 * Infer the root component selector from the first App*.qml.ts file in the
 * source tree, applying the standard kebab-case convention.
 */
function inferRootSelector(sources: string[], prefix: string): string {
  // Find first file that contains a class declaration starting with "App"
  for (const absSrc of sources) {
    const fileName = basename(absSrc, ".qml.ts");
    if (fileName === "App" || fileName.startsWith("App")) {
      const className = fileName + "Controller";
      return `${prefix}-${className
        .replace(/([A-Z])/g, '-$1')
        .toLowerCase()
        .replace(/^-/, '')}`;
    }
  }
  // Fallback
  return `${prefix}-root`;
}

function inferRootClassName(sources: string[]): string {
  for (const absSrc of sources) {
    const fileName = basename(absSrc, ".qml.ts");
    if (fileName === "App" || fileName.startsWith("App")) {
      return fileName + "ControllerComponent";
    }
  }
  return "AppComponent";
}

function generateIndexHtml(rootSelector: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Mocha App</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; }
  </style>
</head>
<body>
  <${rootSelector}></${rootSelector}>
  <script type="module" src="/main.ts"></script>
</body>
</html>
`;
}

interface MainTsOptions {
  rootClassName: string;
  routesImport: string;
  serviceImports: string[];
  hasRoutes: boolean;
}

function generateMainTs(opts: MainTsOptions): string {
  const imports = [
    `import '@angular/compiler';`,
    `import { bootstrapApplication } from '@angular/platform-browser';`,
    `import { provideZonelessChangeDetection } from '@angular/core';`,
    `import { ${opts.rootClassName} } from './app.component';`,
    ...opts.serviceImports,
  ];
  if (opts.hasRoutes) {
    imports.push(`import { provideRouter } from '@angular/router';`);
    imports.push(`import { QML_ROUTES } from '${opts.routesImport}';`);
  }
  return `${imports.join('\n')}

bootstrapApplication(${opts.rootClassName}, {
  providers: [
    provideZonelessChangeDetection(),${opts.hasRoutes ? '\n    provideRouter(QML_ROUTES),' : ''}
  ],
}).catch((err) => console.error(err));
`;
}

async function generateServiceFile(inj: {
  className: string;
  fileName: string;
  controllerSource: string;
}): Promise<string> {
  // Use the same transform as a regular controller but emit as a service
  // (no @Component wrapper, no template). The class is exported directly.
  const { transformControllerClass } = await import("./controller-codegen.js");
  const transform = transformControllerClass(inj.controllerSource, inj.className);
  if (!transform) {
    return `// Error transforming ${inj.className}\nexport class ${inj.className} {}\n`;
  }

  // Emit the class with @Injectable decorator and providerIn: 'root'
  const bodyLines = transform.bodyLines.map((l) => {
    // Remove the @Injectable() decorator line that transformControllerClass
    // may have included (we add our own below)
    if (l.includes('@Injectable')) return '';
    return l;
  }).filter(Boolean);

  // Determine Angular symbols needed (signal, computed, inject, etc.)
  const bodyText = bodyLines.join('\n');
  const needsInjectable = !/import\s*\{[^}]*Injectable[^}]*\}\s*from\s*['"]@angular\/core['"]/.test(bodyText);
  const usesSignal = /\bsignal\(/.test(bodyText);
  const usesComputed = /\bcomputed\(/.test(bodyText);
  const usesInject = /\binject\(/.test(bodyText);

  const symbols = new Set<string>();
  if (needsInjectable) symbols.add('Injectable');
  if (usesSignal) symbols.add('signal');
  if (usesComputed) symbols.add('computed');
  if (usesInject) symbols.add('inject');

  const lines: string[] = [];
  if (symbols.size > 0) {
    lines.push(`import { ${[...symbols].sort().join(', ')} } from '@angular/core';`);
  }
  lines.push('');
  lines.push(`@Injectable({ providedIn: 'root' })`);
  lines.push(`export class ${inj.className} {`);
  for (const l of bodyLines) {
    lines.push(l);
  }
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

/** Remove the codegen output. Useful in cleanup hooks. */
export async function cleanWebProject(outDir: string): Promise<void> {
  const abs = resolve(process.cwd(), outDir);
  await rm(abs, { recursive: true, force: true });
}

/* ──────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────*/

async function safeStat(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function collectQmlTs(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string) {
    let entries: string[];
    try {
      entries = await readdir(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".mocha" || entry.startsWith(".")) {
        continue;
      }
      const p = join(d, entry);
      let s: any;
      try {
        s = await stat(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        await walk(p);
      } else if (s.isFile()) {
        if (entry.endsWith(".qml.ts")) out.push(p);
        else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
          // Also collect plain .ts files to find @Injectable services.
          // We only use these for service scaffolding, not for component
          // generation.
          out.push(p);
        }
      }
    }
  }
  await walk(dir);
  return out;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

interface CacheData {
  hash: string;
  routes: GeneratedRoute[];
}

/**
 * Read the per-file codegen cache. The cache stores `{hash, routes}` as JSON
 * so that future cache hits can restore the routes extracted from this file
 * without re-running `transformQmlTs()`. Without persisting routes, a re-run
 * that hits cache on every file would overwrite `qml-routes.ts` with an
 * empty array.
 *
 * Old format (bare SHA-256 hex string) is treated as a parse failure and
 * falls through to a cache miss → next write replaces with the new format.
 */
async function readCache(path: string): Promise<CacheData | null> {
  try {
    const text = (await readFile(path, "utf-8")).trim();
    if (!text) return null;
    const parsed = JSON.parse(text) as Partial<CacheData>;
    if (typeof parsed.hash !== "string") return null;
    return {
      hash: parsed.hash,
      routes: Array.isArray(parsed.routes) ? parsed.routes : [],
    };
  } catch {
    return null;
  }
}

async function writeCache(
  path: string,
  hash: string,
  routes: GeneratedRoute[]
): Promise<void> {
  const data: CacheData = { hash, routes };
  await writeFile(path, JSON.stringify(data), "utf-8");
}

function pascalToKebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

/**
 * Rewrite `import('./<rel>.qml.ts')` in loadComponent() to point at the
 * generated Angular component file path (`./<kebab>.component.js`).
 *
 * Original emit:
 *   loadComponent: () => import('./views/Home.qml.ts').then(m => m.HomeControllerComponent)
 * After:
 *   loadComponent: () => import('./views/home.component.js').then(m => m.HomeControllerComponent)
 */
function rewriteRouteImports(source: string): string {
  return source.replace(
    /import\(\s*['"]([^'"]+?)\.qml\.ts['"]\s*\)\.then\(\s*m\s*=>\s*m\.(\w+)Component\s*\)/g,
    (_full, relPath: string, ctrlClass: string) => {
      const trimmed = relPath.replace(/^\.\//, "");
      const parts = trimmed.split(/[\\/]/);
      const lastName = parts.pop()!;
      const dirPrefix = parts.length ? "./" + parts.join("/") + "/" : "./";
      return `import('${dirPrefix}${pascalToKebab(
        lastName
      )}.component.js').then(m => m.${ctrlClass}Component)`;
    }
  );
}

/**
 * Strip the per-file `export const QML_ROUTES = [...]` block from a generated
 * component TS, since the canonical routes live in `qml-routes.ts`.
 */
function stripEmbeddedRoutes(source: string): string {
  return source.replace(
    /\nexport const QML_ROUTES = \[[\s\S]*?\n\];\n?/,
    "\n"
  );
}

function generateRoutesModule(routes: GeneratedRoute[]): string {
  const imports: string[] = [];
  const seen = new Set<string>();

  for (const r of routes) {
    const importPath = r.loadFrom.replace(/\.js$/, "");
    if (!seen.has(importPath)) {
      imports.push(`import { ${r.componentClass} } from '${importPath}';`);
      seen.add(importPath);
    }
  }

  if (routes.length === 0) {
    return [
      `import { Routes } from '@angular/router';`,
      ``,
      `export const routes: Routes = [];`,
      ``,
    ].join("\n");
  }

  const entries = routes
    .map((r) => {
      const loadPath = r.loadFrom.replace(/\.js$/, "");
      return `  { path: '${r.path}', loadComponent: () => import('${loadPath}').then(m => m.${r.componentClass}) }`;
    })
    .join(",\n");

  return [
    `import { Routes } from '@angular/router';`,
    ...imports,
    ``,
    `export const routes: Routes = [\n${entries}\n];`,
    ``,
  ].join("\n");
}
