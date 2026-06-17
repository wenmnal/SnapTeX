import katex from 'katex';
import { RenderContext } from './types';
import { escapeHtmlAttribute, resolveLatexStyles } from './utils';
import { renderMathJax } from './mathjax-renderer';

/**
 * Built-in KaTeX macros for common LaTeX packages we don't otherwise support.
 * Lets KaTeX render documents that use the `physics` package without crashing
 * the entire formula. MathJax has its own `physics` package configuration.
 */
const KATEX_BUILTIN_MACROS: Record<string, string> = {
    // physics package — minimal subset
    '\\qty': '\\left(#1\\right)',
    '\\Bqty': '\\left\\{#1\\right\\}',
    '\\absolutevalue': '\\left|#1\\right|',
    '\\abs': '\\left|#1\\right|',
    '\\norm': '\\left\\|#1\\right\\|',
    '\\eval': '\\left.#1\\right|',
    '\\order': 'O(#1)',
    '\\bra': '\\left\\langle#1\\right|',
    '\\ket': '\\left|#1\\right\\rangle',
    '\\braket': '\\left\\langle#1|#2\\right\\rangle',
    '\\dd': '\\mathrm{d}',
    '\\dv': '\\frac{\\mathrm{d}#1}{\\mathrm{d}#2}',
    '\\pdv': '\\frac{\\partial#1}{\\partial#2}',
    '\\grad': '\\vec{\\nabla}',
    '\\curl': '\\vec{\\nabla}\\times',
    '\\Tr': '\\operatorname{Tr}',
    '\\tr': '\\operatorname{tr}',
    // slashed package
    '\\slashed': '\\not{#1}',
};

/**
 * Renders TeX math through KaTeX or MathJax and protects the generated HTML from Markdown.
 */
export function renderMath(tex: string, displayMode: boolean, renderer: RenderContext): string {
    if (renderer.mathRenderer === 'mathjax') {
        try {
            const html = renderMathJax(tex, displayMode, renderer.currentMacros);
            return renderer.protectHtml('math', html);
        } catch (e) {
            return renderer.protectHtml('math', `<span style="color:red">MathJax Error</span>`);
        }
    }
    // existing KaTeX code unchanged
    try {
        const macros = { ...KATEX_BUILTIN_MACROS, ...renderer.currentMacros };
        const html = katex.renderToString(tex, {
            displayMode: displayMode,
            macros: macros,
            throwOnError: false,
            errorColor: '#cc0000',
            globalGroup: true,
            trust: false
        });
        return renderer.protectHtml('math', html);
    } catch (e) {
        return renderer.protectHtml('math', `<span style="color:red">Math Error</span>`);
    }
}

/**
 * Creates a protected reference placeholder that scanner numbering fills later.
 *
 * KaTeX path: `\text{<protected-anchor>}` — the webview replaces the `?` glyph
 * with the resolved label number after the block lands in the DOM (see
 * `applyNumbering` in webview/main.ts).
 *
 * MathJax path: MathJax compiles `\text{}` into glyph outlines, so the
 * protection token and any embedded HTML would be lost. Substitute the label's
 * resolved number directly into the TeX source so MathJax typesets the digits
 * itself. The number is wrapped in `\href{#key}{...}` so the resulting SVG
 * still contains a navigable anchor; webview-side click sync handles the rest.
 */
export function createRefLink(key: string, renderer: RenderContext, type: 'ref' | 'eqref' = 'ref'): string {
    const safeKey = escapeHtmlAttribute(key);

    if (renderer.mathRenderer === 'mathjax') {
        const resolved = renderer.labelMap[key];
        const display = resolved !== undefined ? resolved : '?';
        const safeHref = safeKey.replace(/[\\{}]/g, ch => `\\${ch}`);
        const tex = `\\href{#${safeHref}}{\\text{${display}}}`;
        return type === 'eqref' ? `(${tex})` : tex;
    }

    const html = `<a href="#${safeKey}" class="sn-ref" data-key="${safeKey}" style="color:inherit; text-decoration:none;">?</a>`;
    const token = renderer.protectHtml('ref', html);
    if (type === 'eqref') {
        return `(\\text{${token}})`;
    }
    return `\\text{${token}}`;
}

/**
 * Recovers protection tokens that were embedded in ignored float regions.
 */
export function recoverPreservedTokens(text: string): string {
    const tokenRegex = /XSNAP:[a-zA-Z0-9_-]+:\d+Y/g;
    let found = "";
    let match;
    while ((match = tokenRegex.exec(text)) !== null) {
        found += match[0];
    }
    return found;
}

export function renderCaptionContent(captionText: string, renderer: RenderContext): string {
    const withMath = captionText.replace(/\$((?:\\.|[^\\$])+?)\$/g, (_match: string, content: string) => {
        return renderMath(content.trim(), false, renderer);
    });
    return renderer.renderInline(resolveLatexStyles(withMath, html => renderer.protectHtml('style', html)));
}

export function unwrapResizeboxAroundProtectedContent(text: string): string {
    return text.replace(
        /\\resizebox\s*\{[^{}]*\}\s*\{[^{}]*\}\s*\{\s*((?:XSNAP:[a-zA-Z0-9_-]+:\d+Y\s*)+)\}/g,
        (_match, protectedContent: string) => protectedContent.trim()
    );
}
