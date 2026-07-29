export type Platform = 'web' | 'native' | 'mobile' | 'tv';

export interface HtmlBlock {
  placeholder: string;
  html: string;
}

export interface ProcessedTemplate {
  /** QML with platform blocks evaluated and placeholders kept for web */
  cleaned: string;
  /** Extracted HTML blocks (only for web target) */
  htmlBlocks: HtmlBlock[];
  /** Whether any web-specific HTML blocks were found */
  hasWebBlocks: boolean;
}

const IF_RE = /^\s*#if\s+platform\s*==\s*"(\w+)"\s*/;
const ELIF_RE = /^\s*#elif\s+platform\s*==\s*"(\w+)"\s*/;
const ELSE_RE = /^\s*#else\s*$/;
const ENDIF_RE = /^\s*#endif\s*$/;

/**
 * Preprocess a QML template, evaluating `#if platform == "X"` / `#elif` / `#else` / `#endif`
 * directives for the given target platform.
 *
 * For `web` target:
 *   - Content inside `#if platform == "web"` is extracted as raw HTML
 *     and replaced with a `MochaRawHtml<N>` QML element placeholder.
 *   - Content inside non-web branches is stripped.
 *   - Content outside directives is kept as-is.
 *
 * For `native` / `mobile` / `tv` targets:
 *   - Only matching platform branches are kept.
 *   - `#if platform == "web"` blocks are stripped entirely.
 *
 * The `MochaRawHtml<N>` placeholders are valid QML element names (uppercase start),
 * so the QML parser will include them as elements. The compiler then replaces
 * them with the raw HTML during code generation.
 */
export function preprocessPlatformDirectives(
  template: string,
  target: Platform
): ProcessedTemplate {
  const lines = template.split('\n');
  const htmlBlocks: HtmlBlock[] = [];
  const out: string[] = [];
  let placeholderCounter = 0;

  // Stack of conditional groups. Each group has branches, where each branch
  // records whether it matched and collects its content lines.
  type Branch = { type: 'if' | 'elif' | 'else'; platform?: string; matched: boolean; lines: string[] };
  const stack: Branch[][] = [];

  let currentBranch: Branch | null = null;

  function appendToCurrent(line: string) {
    if (currentBranch) {
      currentBranch.lines.push(line);
    } else {
      out.push(line);
    }
  }

  function evaluateGroup(group: Branch[]): { keep: string[]; isWeb: boolean } {
    const matched = group.find((b) => b.matched);
    const isWeb = group.some((b) => b.platform === 'web');
    const kept = matched ? matched.lines : [];
    return { keep: kept, isWeb };
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ifMatch = line.match(IF_RE);
    const elifMatch = line.match(ELIF_RE);
    const elseMatch = line.match(ELSE_RE);
    const endifMatch = line.match(ENDIF_RE);

    if (ifMatch) {
      if (stack.length > 0 && !currentBranch) {
        throw new Error(`Nested #if at line ${i + 1} inside already-closed group`);
      }
      const platform = ifMatch[1];
      const matched = platform === target;
      const branch: Branch = { type: 'if', platform, matched, lines: [] };
      stack.push([branch]);
      currentBranch = branch;
      continue;
    }

    if (elifMatch) {
      if (stack.length === 0) throw new Error(`Unmatched #elif at line ${i + 1}`);
      const group = stack[stack.length - 1];
      if (group.some((b) => b.type === 'else')) {
        throw new Error(`#elif after #else at line ${i + 1}`);
      }
      const platform = elifMatch[1];
      const alreadyMatched = group.some((b) => b.matched);
      const branch: Branch = { type: 'elif', platform, matched: !alreadyMatched && platform === target, lines: [] };
      group.push(branch);
      currentBranch = branch;
      continue;
    }

    if (elseMatch) {
      if (stack.length === 0) throw new Error(`Unmatched #else at line ${i + 1}`);
      const group = stack[stack.length - 1];
      if (group.some((b) => b.type === 'else')) throw new Error(`Duplicate #else at line ${i + 1}`);
      const alreadyMatched = group.some((b) => b.matched);
      const branch: Branch = { type: 'else', matched: !alreadyMatched, lines: [] };
      group.push(branch);
      currentBranch = branch;
      continue;
    }

    if (endifMatch) {
      if (stack.length === 0) throw new Error(`Unmatched #endif at line ${i + 1}`);
      const group = stack.pop()!;
      const { keep, isWeb } = evaluateGroup(group);

      if (target === 'web' && isWeb) {
        const htmlContent = keep.join('\n');
        const placeholder = `MochaRawHtml${placeholderCounter++}`;
        htmlBlocks.push({ placeholder, html: htmlContent });
        out.push(`    ${placeholder} {}`);
      } else {
        out.push(...keep);
      }

      currentBranch = stack.length > 0 ? stack[stack.length - 1][stack[stack.length - 1].length - 1] : null;
      continue;
    }

    // Regular line
    appendToCurrent(line);
  }

  if (stack.length > 0) {
    throw new Error(`Unterminated #if block (expected #endif)`);
  }

  const cleaned = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  return {
    cleaned,
    htmlBlocks,
    hasWebBlocks: htmlBlocks.length > 0,
  };
}
