/**
 * Codegen entry: runs at build/dev time (Node only). Do NOT import this from
 * code that will be bundled for the browser — it pulls in node:fs, node:path,
 * node:crypto. Apps should depend on `@mocha-framework/compiler-web` (browser-safe)
 * and use this subpath entry only from build tooling.
 */

export {
  generateWebProject,
  cleanWebProject,
} from './codegen.js';
export type {
  CodegenOptions,
  CodegenResult,
  GeneratedRoute,
} from './codegen.js';
