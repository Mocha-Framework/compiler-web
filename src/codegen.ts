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

  for (const absSrc of sources) {
    const source = await readFile(absSrc, "utf-8");
    const hash = sha256(source);
    const cachePath = `${absSrc}.mochacache`;

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
        const targetPascal = segments.pop()!;
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

  return result;
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
    // loadFrom is e.g. "./views/home.component.js" — turn into "./views/home.component"
    const importPath = r.loadFrom.replace(/\.js$/, "");
    if (!seen.has(importPath)) {
      imports.push(`import { ${r.componentClass} } from '${importPath}';`);
      seen.add(importPath);
    }
  }

  const entries = routes
    .map((r) => {
      // loadFrom here without .js — Vite/Rollup will resolve either way,
      // but the embedded template literal in qml-routes.ts is consumed by
      // ts/esbuild, so we keep the .js extension explicit at runtime.
      return `  { path: '${r.path}', loadComponent: () => import('${r.loadFrom}').then(m => m.${r.componentClass}) }`;
    })
    .join(",\n");

  return [
    `/* AUTO-GENERATED. Do not edit. */`,
    `import type { Routes } from '@angular/router';`,
    ...imports,
    ``,
    `export const QML_ROUTES: Routes = [\n${entries}\n];`,
    ``,
  ].join("\n");
}
