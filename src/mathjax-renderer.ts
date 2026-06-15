/**
 * MathJax server-side renderer using mathjax-full with SVG output.
 *
 * Lazy-initialized singleton — created on first render call, reused across
 * all subsequent calls. Recreated when macros change.
 */

import { mathjax } from 'mathjax-full/js/mathjax';
import { TeX } from 'mathjax-full/js/input/tex';
import { SVG } from 'mathjax-full/js/output/svg';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages';
// physics is NOT in AllPackages (it redefines several standard macros) —
// import its configuration as a side-effect to register it with the TeX
// input jax, then we add 'physics' to the packages list below.
import 'mathjax-full/js/input/tex/physics/PhysicsConfiguration';

// ── Singleton state ──────────────────────────────────────────────────────────

let adaptor: ReturnType<typeof liteAdaptor> | null = null;
let mjDocument: ReturnType<typeof mathjax.document> | null = null;
let svgOutput: SVG<any, any, any> | null = null;
let cachedMacrosJson: string = '';
let cachedCSS: string = '';

/**
 * Converts KaTeX-format macros to MathJax format.
 *
 * KaTeX macros use backslash-prefixed keys:  `{'\\R': '\\mathbb{R}'}`
 * MathJax expects plain keys with optional argument counts:
 *   - No arguments:  `{'R': '\\mathbb{R}'}`
 *   - With arguments: `{'vect': ['\\mathbf{#1}', 1]}`
 *
 * Argument count is determined by finding the highest `#N` reference in the
 * expansion string.
 */
function convertMacros(katexMacros: Record<string, string>): Record<string, string | [string, number]> {
    const result: Record<string, string | [string, number]> = {};
    for (const [key, expansion] of Object.entries(katexMacros)) {
        // Strip leading backslashes from the key
        const cleanKey = key.replace(/^\\+/, '');
        if (!cleanKey) { continue; }

        // Count arguments by finding highest #N reference
        let maxArg = 0;
        const argRegex = /#(\d)/g;
        let match;
        while ((match = argRegex.exec(expansion)) !== null) {
            const argNum = parseInt(match[1], 10);
            if (argNum > maxArg) { maxArg = argNum; }
        }

        if (maxArg > 0) {
            result[cleanKey] = [expansion, maxArg];
        } else {
            result[cleanKey] = expansion;
        }
    }
    return result;
}

/**
 * Ensures the MathJax singleton is initialized and up-to-date with the
 * given macros. Recreates the instance when macros change.
 */
function ensureInstance(macros: Record<string, string>): void {
    const macrosJson = JSON.stringify(macros);

    if (mjDocument && macrosJson === cachedMacrosJson) {
        return;
    }

    // (Re)create adaptor only once
    if (!adaptor) {
        adaptor = liteAdaptor();
        RegisterHTMLHandler(adaptor);
    }

    const mjMacros = convertMacros(macros);

    const tex = new TeX({
        packages: AllPackages.concat(['internalMath', 'physics']),
        macros: mjMacros
    });

    svgOutput = new SVG({ fontCache: 'local' });

    mjDocument = mathjax.document('', {
        InputJax: tex,
        OutputJax: svgOutput
    });

    cachedMacrosJson = macrosJson;
    cachedCSS = '';  // invalidate CSS cache
}

/**
 * Renders a TeX string to an SVG-based HTML string using MathJax.
 *
 * @param tex       - The TeX source to render.
 * @param displayMode - `true` for display-style math, `false` for inline.
 * @param macros    - KaTeX-format macro dictionary (backslash-prefixed keys).
 * @returns           An HTML string containing the rendered SVG output.
 */
export function renderMathJax(tex: string, displayMode: boolean, macros: Record<string, string>): string {
    ensureInstance(macros);

    try {
        const node = mjDocument!.convert(tex, { display: displayMode });
        return adaptor!.outerHTML(node);
    } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        return `<span style="color:red">MathJax Error: ${message}</span>`;
    }
}

/**
 * Returns the CSS string required by MathJax SVG output.
 *
 * The CSS is cached after the first call and invalidated when the MathJax
 * instance is recreated (e.g. due to macro changes).
 */
export function getMathJaxCSS(): string {
    if (cachedCSS) {
        return cachedCSS;
    }
    if (!svgOutput || !mjDocument || !adaptor) {
        return '';
    }
    cachedCSS = adaptor.textContent(svgOutput.styleSheet(mjDocument) as any);
    return cachedCSS;
}

/**
 * Clears the cached MathJax instance so it will be recreated on next render.
 */
export function resetMathJax(): void {
    mjDocument = null;
    svgOutput = null;
    cachedMacrosJson = '';
    cachedCSS = '';
}
