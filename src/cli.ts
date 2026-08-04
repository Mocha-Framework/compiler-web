#!/usr/bin/env node
/**
 * AOT CLI for @mocha-framework/compiler-web.
 *
 * Scan .qml.ts files in a project and generate Angular component files.
 *
 * Usage:
 *   npx mocha-compile-web --src src/App.qml.ts --out dist/angular/
 *
 * Or via mocha CLI:
 *   mocha build --target web
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, relative, extname } from 'node:path';
import { transformQmlTs } from './vite-plugin.js';
import type { CompiledComponent } from './qml-to-angular.js';

export interface CliOptions {
  src: string;
  out: string;
  target?: 'web' | 'native' | 'mobile' | 'tv';
  selectorPrefix?: string;
  watch?: boolean;
}

export async function runCli(options: CliOptions): Promise<void> {
  const srcPath = resolve(process.cwd(), options.src);
  const outDir = resolve(process.cwd(), options.out);
  const target = options.target ?? 'web';
  const prefix = options.selectorPrefix ?? 'app';

  if (!existsSync(srcPath)) {
    console.error(`[@mocha-framework/compiler-web] Source not found: ${srcPath}`);
    process.exit(1);
  }

  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  const source = readFileSync(srcPath, 'utf-8');

  try {
    const result = transformQmlTs(source, target as any, prefix);

    const baseName = options.src.replace(/\.qml\.ts$/, '');
    const componentName = baseName.split('/').pop() || 'component';
    const outTs = resolve(outDir, `${componentName}.component.ts`);
    const outHtml = resolve(outDir, `${componentName}.component.html`);

    writeFileSync(outTs, result.componentTs, 'utf-8');
    writeFileSync(outHtml, result.template, 'utf-8');

    console.log(`[@mocha-framework/compiler-web] Generated:`);
    console.log(`  ${outTs}`);
    console.log(`  ${outHtml}`);

    if (result.warnings.length > 0) {
      console.log(`\nWarnings:`);
      for (const w of result.warnings) {
        console.log(`  ⚠ ${w}`);
      }
    }
  } catch (e: any) {
    console.error(`[@mocha-framework/compiler-web] Compilation failed:`, e.message);
    process.exit(1);
  }
}

// CLI entry point
if (process.argv[1]?.endsWith('cli.js') || process.argv[1]?.endsWith('cli.ts')) {
  const args = process.argv.slice(2);
  const options: CliOptions = { src: '', out: '' };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--src': options.src = args[++i]; break;
      case '--out': options.out = args[++i]; break;
      case '--target': options.target = args[++i] as any; break;
      case '--prefix': options.selectorPrefix = args[++i]; break;
      case '--watch': options.watch = true; break;
    }
  }

  if (!options.src || !options.out) {
    console.error('Usage: mocha-compile-web --src <file.qml.ts> --out <output-dir> [--target web|native|mobile|tv] [--prefix app]');
    process.exit(1);
  }

  runCli(options).catch(console.error);
}
