export {
  preprocessPlatformDirectives,
} from './platform-directives.js';
export type { Platform, ProcessedTemplate, HtmlBlock } from './platform-directives.js';

export {
  compileQmlToAngular,
} from './qml-to-angular.js';
export type { CompiledComponent, CompileOptions } from './qml-to-angular.js';

export {
  getElementDef,
  hasQmlNgComponent,
} from './element-mapper.js';

export {
  toQSignal,
  toWritableQSignal,
} from './qprop-to-signal.js';

export {
  deriveTagName,
  tagToSelector,
  extractQmlComponentAs,
  extractClassName,
  extractInputNames,
  extractOutputNames,
  extractModelNames,
  extractQPropertyNamesFromSource,
  extractChildControllerInfo,
  buildChildRegistry,
} from './child-component-info.js';
export type { ChildControllerInfo } from './child-component-info.js';

// Codegen and node-only tooling live in their own entry so the browser bundle
// doesn't pull in node:fs / node:path / node:crypto transitively via
// @mocha/compiler-web.
// transformQmlTs is exported from @mocha/compiler-web/vite-plugin
// generateWebProject / cleanWebProject are exported from @mocha/compiler-web/codegen
