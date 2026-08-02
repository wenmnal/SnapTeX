import {
    BUILTIN_METADATA_EXTRACTOR,
    readMetadataCommand
} from './metadata';
import {
    toRoman,
    createHiddenLabelAnchor,
    escapeHtml,
    escapeHtmlAttribute,
    extractAndHideLabels,
    formatEnumerateLabel,
    splitLatexCitationKeys,
    replaceLatexCommandCalls,
    resolveLatexStyles,
    stripLatexComments
} from './utils';
import { BlockDependencyRule, PreprocessRule, RenderContext, RuleRegistry, SplitterConfig, SplitterRule } from './types';
import { BibTexParser } from './bib';
import {
    REGEX_STR,
    R_LABEL,
    R_REF,
    R_CREF,
    R_CREFRANGE,
    R_CITATION,
    R_BIBLIOGRAPHY,
    R_ADDBIBRESOURCE,
    R_BIBLIOGRAPHY_STYLE,
    R_THEBIBLIOGRAPHY,
    getTheoremDisplayName
} from './patterns';
import { createRefLink, createStyleHtmlProtector, renderBibliographyItemsHtml, renderExternalLinkHtml, renderInlineLatexHtml, renderMaketitleAuthorsHtml, renderMath, renderNumberedEquationHtml, renderReferenceLinksHtml } from './rule-helpers';
import { createTikzPictureRule } from './rule-tikz';
import { createAlgorithmRule, createFigureRule, createTableRule } from './rule-floats';
import { DEFAULT_AST_RENDER_RULES } from './ast/rules/defaults';
import type { AstRenderRule } from './ast/rules';
export { readAstCommandArguments } from './ast/rules';
export type { AstRenderContext, AstRenderInput, AstRenderResult, AstRenderRule } from './ast/rules';

function replaceLatexLinkCommands(text: string, renderer: RenderContext): string {
    return replaceLatexCommandCalls(text, [
        {
            name: 'href',
            requiredArgs: 2,
            render: call => {
                const styledContent = resolveLatexStyles(call.requiredArgs[1].content, createStyleHtmlProtector(renderer));
                const safeContent = escapeHtml(styledContent);
                const linkHtml = renderExternalLinkHtml(call.requiredArgs[0].content, safeContent, 'latex-href');
                return renderer.protectHtml(linkHtml ? 'link' : 'link-text', linkHtml ?? safeContent);
            }
        },
        {
            name: 'url',
            requiredArgs: 1,
            render: call => {
                const safeContent = escapeHtml(call.requiredArgs[0].content.trim());
                const linkHtml = renderExternalLinkHtml(call.requiredArgs[0].content, safeContent, 'latex-url');
                return renderer.protectHtml(linkHtml ? 'link' : 'link-text', linkHtml ?? safeContent);
            }
        }
    ]);
}

interface CitationPart {
    error: boolean;
    key: string;
    author: string;
    year: string;
}

export function renderCitationHtml(
    cmd: string,
    keys: readonly string[],
    options: { pre?: string; post?: string },
    renderer: Pick<RenderContext, 'resolveCitation' | 'bibEntries'>
): string {
    const safePre = escapeHtml(options.pre ?? '');
    const safePost = escapeHtml(options.post ?? '');
    const parts: CitationPart[] = keys.map((key: string) => {
        renderer.resolveCitation(key);
        const entry = renderer.bibEntries.get(key);
        if (!entry) { return { error: true, key, author: "unknown", year: "unknown" }; }
        const author = BibTexParser.getShortAuthor(entry);
        const year = escapeHtml(entry.fields.year || "unknown");
        return { error: false, key, author, year };
    });

    const mkLink = (text: string, key: string) => {
        const safeKey = escapeHtmlAttribute(key);
        return `<a href="#ref-${safeKey}" class="latex-cite-link" style="color:#2e7d32; text-decoration:none;">${text}</a>`;
    };
    const renderYearText = (part: CitationPart, isLast: boolean) => {
        if (part.error) { return `[${escapeHtml(part.key)}?]`; }
        const suffix = isLast && safePost ? `, ${safePost}` : '';
        return mkLink(`${part.year}${suffix}`, part.key);
    };

    if (cmd === 'citet') {
        const formatted = parts.map((part, i) => {
            const isLast = i === parts.length - 1;
            if (part.error) { return renderYearText(part, isLast); }
            return `${part.author} (${renderYearText(part, isLast)})`;
        }).join(', ');
        return safePre + formatted;
    }

    if (cmd === 'citeyear') {
        return safePre + parts.map((part, i) => renderYearText(part, i === parts.length - 1)).join(', ');
    }

    let content = parts.map(part => {
        if (part.error) { return `[${escapeHtml(part.key)}?]`; }
        return mkLink(`${part.author}, ${part.year}`, part.key);
    }).join('; ');
    if (safePre) { content = safePre + content; }
    if (safePost) { content = content + ', ' + safePost; }
    return `(${content})`;
}

function replaceMathRefs(content: string, renderer: RenderContext): string {
    return content.replace(/\\(ref|eqref)\*?\{([^}]+)\}/g, (_match, reftype, key) => createRefLink(key, renderer, reftype));
}

/**
 * Ordered LaTeX-to-Markdown preprocessing pipeline.
 *
 * Rules consume small LaTeX constructs before Markdown-it runs. Any generated
 * HTML must go through RenderContext.protectHtml so Markdown-it cannot escape
 * or expose it as user-visible text.
 */
export function defineBlockDependencyRule(rule: BlockDependencyRule): BlockDependencyRule {
    return rule;
}

export function defineAstRenderRule(rule: AstRenderRule): AstRenderRule {
    return rule;
}

export function defineRuleRegistry(registry: RuleRegistry): RuleRegistry {
    return {
        metadataExtractors: [...registry.metadataExtractors],
        renderRules: [...registry.renderRules].sort((a, b) => a.priority - b.priority),
        astRenderRules: [...registry.astRenderRules],
        blockDependencyRules: [...registry.blockDependencyRules],
        splitterConfig: { ...registry.splitterConfig },
        splitterRules: [...registry.splitterRules]
    };
}

const envPattern = (fragment: string, allowStar = false) => new RegExp(`^(${fragment})${allowStar ? '\\*?' : ''}$`);

// User-facing splitter settings. Long protected constructs get a larger window
// before the splitter treats them as malformed and resumes emergency splitting.
export const DEFAULT_SPLITTER_CONFIG: SplitterConfig = {
    maxBlockLines: 40,
    maxNoEmergencySplitLines: 400
};

export const DEFAULT_SPLITTER_RULES: SplitterRule[] = [
    { name: 'ignored-environments', kind: 'ignored-env', envPattern: envPattern(`${REGEX_STR.SPLITTER_IGNORED}|appendices`) },
    { name: 'transparent-containers', kind: 'transparent-env', envPattern: envPattern('appendices') },
    { name: 'transparent-proof-containers', kind: 'transparent-env', envPattern: envPattern('proof'), preserveWrapper: true },
    { name: 'transparent-list-containers', kind: 'transparent-env', envPattern: envPattern('itemize|enumerate'), preserveWrapper: true },
    { name: 'split-environments', kind: 'split-env', envPattern: envPattern(`${REGEX_STR.SPLITTER_MAJOR}|thebibliography|tikzpicture`, true) },
    { name: 'list-tikz-and-bibliography', kind: 'no-emergency-split-env', envPattern: envPattern('itemize|enumerate|thebibliography|tikzpicture') },
    {
        name: 'long-brace-groups',
        kind: 'no-emergency-split-begin-token',
        beginTokenPattern: /(?:\{\\(?:color\{[a-zA-Z0-9]+\}|(?:bf|it|sf|rm|tt)\b)|\\resizebox\s*\{[^{}]*\}\s*\{[^{}]*\}\s*\{)/
    },
    { name: 'emergency-split-math-end', kind: 'emergency-split-end-env', envPattern: envPattern(REGEX_STR.MATH_ENVS, true) }
];

/**
 * Complete custom metadata example.
 *
 * It stores \editor{...} as metadata.custom.editor. The default \maketitle
 * rule reads this custom field and refreshes when it changes.
 */
export const EDITOR_METADATA_EXTRACTOR = {
    name: 'editor-example',
    extract: (source: string) => {
        const editor = readMetadataCommand(source, 'editor');
        return editor
            ? { custom: { editor: editor.content }, ranges: [editor.range] }
            : {};
    }
};

function abstractSentinel(content: string): string {
    const trimmed = content.trim();
    return trimmed ? `\n\nOOABSTRACT_STARTOO\n\n${trimmed}\n\nOOABSTRACT_ENDOO\n\n` : '';
}

function keywordsSentinel(content: string): string {
    const trimmed = content.trim();
    return trimmed ? `\n\nOOKEYWORDS_STARTOO${trimmed}OOKEYWORDS_ENDOO\n\n` : '';
}

const ENUMERATE_LABEL_MARKER = 'SNAP_ENUM_LABEL:';

function encodeEnumerateLabel(label: string): string {
    return `${ENUMERATE_LABEL_MARKER}${encodeURIComponent(label)}`;
}

function decodeEnumerateLabel(label: string): string {
    return label.startsWith(ENUMERATE_LABEL_MARKER)
        ? decodeURIComponent(label.slice(ENUMERATE_LABEL_MARKER.length))
        : label;
}

function renderListLabel(label: string, renderer: RenderContext): string {
    const withMath = label.replace(/\$((?:\\.|[^\\$])*)\$/g, (_match, content) => renderMath(content, false, renderer));
    return escapeHtml(resolveLatexStyles(withMath, createStyleHtmlProtector(renderer)));
}

function renderLatexListContent(content: string, renderer: RenderContext): string {
    const nestedLists = renderLatexLists(content, renderer);
    const styled = resolveLatexStyles(nestedLists, createStyleHtmlProtector(renderer));
    return renderer.renderInline(styled.trim());
}

function renderLatexLists(text: string, renderer: RenderContext): string {
    const beginRegex = /\\begin\{(itemize|enumerate)\}\s*(?:\[([^\]]*)\])?/g;
    let result = "";
    let cursor = 0;
    let match: RegExpExecArray | null;

    while ((match = beginRegex.exec(text)) !== null) {
        const end = findListEnvironmentEnd(text, beginRegex.lastIndex);
        if (!end) {
            continue;
        }

        result += text.slice(cursor, match.index);
        result += renderer.protectHtml('list', renderLatexListHtml(
            match[1] === 'enumerate' ? 'ol' : 'ul',
            match[2] ? decodeEnumerateLabel(match[2]) : undefined,
            text.slice(beginRegex.lastIndex, end.contentEnd),
            renderer
        ));
        cursor = end.end;
        beginRegex.lastIndex = cursor;
    }

    return result + text.slice(cursor);
}

function findListEnvironmentEnd(text: string, start: number): { contentEnd: number; end: number } | undefined {
    const tokenRegex = /\\(begin|end)\{(itemize|enumerate)\}/g;
    tokenRegex.lastIndex = start;
    let depth = 1;
    let match: RegExpExecArray | null;

    while ((match = tokenRegex.exec(text)) !== null) {
        depth += match[1] === 'begin' ? 1 : -1;
        if (depth === 0) {
            return { contentEnd: match.index, end: tokenRegex.lastIndex };
        }
    }

    return undefined;
}

function renderLatexListHtml(
    tagName: 'ul' | 'ol',
    labelTemplate: string | undefined,
    content: string,
    renderer: RenderContext
): string {
    const items = splitLatexListItems(content);
    if (items.length === 0) {
        return '';
    }

    const itemHtml = items.map((item, index) => {
        const rawLabel = item.label ?? (labelTemplate ? formatEnumerateLabel(labelTemplate, index + 1) : '');
        const labelHtml = rawLabel ? `<span class="latex-list-label">${renderListLabel(rawLabel, renderer)}</span> ` : '';
        return `<li>${labelHtml}${renderLatexListContent(item.content, renderer)}</li>`;
    }).join('');
    const className = labelTemplate || items.some(item => item.label) ? 'latex-list latex-list-custom-label' : 'latex-list';

    return `<${tagName} class="${className}">${itemHtml}</${tagName}>`;
}

function splitLatexListItems(content: string): Array<{ label?: string; content: string }> {
    const items: Array<{ label?: string; content: string }> = [];
    const tokenRegex = /\\begin\{(?:itemize|enumerate)\}|\\end\{(?:itemize|enumerate)\}|\\item(?:\s*\[([^\]]*)\])?/g;
    let depth = 0;
    let current: { label?: string; start: number } | undefined;
    let match: RegExpExecArray | null;

    while ((match = tokenRegex.exec(content)) !== null) {
        if (match[0].startsWith('\\begin')) {
            depth++;
            continue;
        }
        if (match[0].startsWith('\\end')) {
            depth = Math.max(0, depth - 1);
            continue;
        }
        if (depth > 0) {
            continue;
        }
        if (current) {
            items.push({ label: current.label, content: content.slice(current.start, match.index) });
        }
        current = { label: match[1] ? decodeEnumerateLabel(match[1]) : undefined, start: tokenRegex.lastIndex };
    }

    if (current) {
        items.push({ label: current.label, content: content.slice(current.start) });
    }
    return items;
}

export const DEFAULT_RENDER_RULES: PreprocessRule[] = [
    {
        name: 'clean_comments',
        priority: 5,
        apply: text => stripLatexComments(text)
    },

    createTikzPictureRule(),

    {
        name: 'escaped_char_dollar',
        priority: 10,
        apply: (text, renderer: RenderContext) => {
            return text.replace(/\\([$])/g, () => renderer.protectHtml('raw', '&#36;'));
        }
    },

    {
        name: 'clean_layout_cmds',
        priority: 15,
        apply: (text, renderer: RenderContext) => {

            text = text.replace(/\\(baselineskip|parskip|parindent)\s*=?\s*[-+]?\d+(?:\.\d+)?\s*[a-zA-Z]{2}\s*/g, '');
            text = text.replace(/\\(vspace|hspace)\*?\{[^}]+\}\s*/g, '');
            text = text.replace(/\\(setlength|addtolength)\{[^}]+\}\{[^}]+\}\s*/g, '');
            text = text.replace(/\\(?:appendix\b|begin\{appendices\}|end\{appendices\})\s*/g, '');

            text = text.replace(/\\noindent\s*/g, () => renderer.protectHtml('raw', '<span class="no-indent-marker"></span>'));

            return text;
        }
    },

    {
        name: 'mbox',
        priority: 20,
        apply: (text) => {
            return text.replace(/\\mbox/g, '\\text');
        }
    },

    {
        name: 'romannumeral',
        priority: 30,
        apply: (text) => {
            return text.replace(/\\(Rmnum|rmnum|romannumeral)\s*\{?(\d+)\}?/g, (_match, cmd, numStr) => {
                return toRoman(parseInt(numStr), cmd === 'Rmnum');
            });
        }
    },

    {
        name: 'display_math',
        priority: 40,
        apply: (text, renderer: RenderContext) => {
            const mathBlockRegex = new RegExp(
                `(\\$\\$([\\s\\S]*?)\\$\\$)|(\\\\\\[([\\s\\S]*?)\\\\\\])|(\\\\begin\\{(${REGEX_STR.MATH_ENVS})(\\*?)\\}([\\s\\S]*?)\\\\end\\{\\6\\7\\})`,
                'gi'
            );

            return text.replace(mathBlockRegex, (match, _m1, c1, _m3, c4, _m5, envName, star, c8, offset, fullString) => {
                if (offset > 0 && fullString[offset - 1] === '\\') { return match; }

                let content = c1 || c4 || c8 || match;

                let eqNumHTML = "";
                if (envName && star !== '*') {
                    eqNumHTML = `(<span class="sn-cnt" data-type="eq"></span>)`;
                }

                const { cleanContent, hiddenHtml } = extractAndHideLabels(content);
                let finalMath = cleanContent.trim();

                finalMath = replaceMathRefs(finalMath, renderer);

                if (envName) {
                    const name = envName.toLowerCase();
                    if (['align', 'flalign', 'alignat', 'multline'].includes(name)) {
                        finalMath = `\\begin{aligned}\n${finalMath}\n\\end{aligned}`;
                    } else if (name === 'gather') {
                        finalMath = `\\begin{gathered}\n${finalMath}\n\\end{gathered}`;
                    }
                }

                const protectedTag = renderMath(finalMath, true, renderer);

                const afterMatch = fullString.substring(offset + match.length);
                const isFollowedByText = /^\s*\S/.test(afterMatch) && !/^\s*\n\n/.test(afterMatch);

                const hiddenLabels = hiddenHtml ? renderer.protectHtml('raw', hiddenHtml) : '';
                let result = protectedTag + hiddenLabels;
                if (eqNumHTML) {
                    result = renderer.protectHtml('math-block', renderNumberedEquationHtml(protectedTag, eqNumHTML, hiddenLabels));
                }
                return result + (isFollowedByText ? renderer.protectHtml('raw', '<span class="no-indent-marker"></span>') : '');
            });
        }
    },

    {
        name: 'enumerate_label_markers',
        priority: 45,
        apply: text => text.replace(/\\begin\{enumerate\}\s*\[([^\]]*)\]/g, (_match, label) => {
            return `\\begin{enumerate}[${encodeEnumerateLabel(label)}]`;
        })
    },

    {
        name: 'inline_math',
        priority: 50,
        apply: (text, renderer: RenderContext) => {
            const processInline = (content: string) => {
                const safeContent = replaceMathRefs(content, renderer);
                return renderMath(safeContent, false, renderer);
            };

            text = text.replace(/\\\(([\s\S]*?)\\\)/gm, (_match, content) => processInline(content));
            return text.replace(/(\\?)\$((?:\\.|[^\\$])*)\$/gm, (match, backslash, content) => {
                if (backslash === '\\') { return match; }
                return processInline(content);
            });
        }
    },

    {
        name: 'refs_and_labels',
        priority: 60,
        apply: (text, renderer: RenderContext) => {
            text = text.replace(new RegExp(R_LABEL, 'g'), (_match, labelName) => {
                return renderer.protectHtml('raw', createHiddenLabelAnchor(labelName));
            });

            text = text.replace(R_REF, (_match, type, labels) => {
                return renderer.protectHtml('ref', renderReferenceLinksHtml(labels.split(','), type === 'eqref' ? 'eqref' : 'ref'));
            });

            const crefPrefix = (key: string, capitalized: boolean): string => {
                const names: Record<string, [string, string]> = {
                    eq: ['eq.', 'Eq.'], equation: ['eq.', 'Eq.'], fig: ['fig.', 'Fig.'], figure: ['fig.', 'Fig.'],
                    tbl: ['table', 'Table'], tab: ['table', 'Table'], table: ['table', 'Table'],
                    sec: ['sec.', 'Sec.'], section: ['sec.', 'Sec.'], chap: ['chap.', 'Chap.'], chapter: ['chap.', 'Chap.'],
                    alg: ['alg.', 'Alg.'], algorithm: ['alg.', 'Alg.'], thm: ['thm.', 'Thm.'], theorem: ['thm.', 'Thm.'],
                    lem: ['lemma', 'Lemma'], lemma: ['lemma', 'Lemma'], cor: ['cor.', 'Cor.'], prop: ['prop.', 'Prop.']
                };
                const name = names[key.split(':', 1)[0].toLowerCase()];
                return name ? `${capitalized ? name[1] : name[0]}&nbsp;` : '';
            };
            text = text.replace(R_CREF, (_match, command: string, labels: string) => {
                const labelList = labels.split(',').map(label => label.trim()).filter(Boolean);
                return labelList.length === 0 ? '' : renderer.protectHtml(
                    'cref',
                    crefPrefix(labelList[0], command === 'Cref') + renderReferenceLinksHtml(labelList)
                );
            });
            text = text.replace(R_CREFRANGE, (_match, command: string, first: string, last: string) => {
                const labels = [first.trim(), last.trim()];
                return renderer.protectHtml(
                    'cref',
                    crefPrefix(labels[0], command === 'Crefrange') + renderReferenceLinksHtml(labels).replace(', ', '–')
                );
            });
            return text;
        }
    },

    {
        name: 'citations',
        priority: 70,
        apply: (text, renderer: RenderContext) => {
            text = text.replace(R_CITATION, (_match, cmd, opt1, opt2, keys) => {
                const keyArray = splitLatexCitationKeys(keys);
                let pre = '';
                let post = '';
                if (opt2 !== undefined) { pre = opt1 ? opt1 + ' ' : ''; post = opt2; }
                else if (opt1 !== undefined) { post = opt1; }
                return renderer.protectHtml('cite', renderCitationHtml(cmd, keyArray, { pre, post }, renderer));
            });
            return text;
        }
    },

    {
        name: 'bibliography',
        priority: 71,
        apply: (text, renderer: RenderContext) => {
            text = text.replace(R_BIBLIOGRAPHY_STYLE, '');
            text = text.replace(R_ADDBIBRESOURCE, '');
            text = text.replace(new RegExp(R_THEBIBLIOGRAPHY, 'gi'), (_match, content) => {
                const entries = Array.from(BibTexParser.parseBibItems(content).values());
                return entries.length
                    ? renderer.protectHtml('bib', renderBibliographyItemsHtml(entries.map(entry => ({ key: entry.key, entry })), renderer))
                    : '';
            });
            const renderExternalBibliography = () => {
                const citedKeys = renderer.getCitedKeys();
                if (citedKeys.length === 0) {
                    return renderer.protectHtml('bib', `<div class="latex-bibliography error">No citations found.</div>`);
                }
                const sortedKeys = Array.from(new Set(citedKeys)).sort((a, b) => {
                    const entryA = renderer.bibEntries.get(a);
                    const entryB = renderer.bibEntries.get(b);
                    const authA = entryA ? (entryA.fields.author || '') : '';
                    const authB = entryB ? (entryB.fields.author || '') : '';
                    return authA.localeCompare(authB);
                });

                return renderer.protectHtml('bib', renderBibliographyItemsHtml(sortedKeys.map(key => ({ key, entry: renderer.bibEntries.get(key) })), renderer));
            };
            text = text.replace(new RegExp(R_BIBLIOGRAPHY, 'g'), renderExternalBibliography);
            return text.replace(/\\printbibliography\b/g, renderExternalBibliography);
        }
    },

    {
        name: 'escaped_chars2',
        priority: 90,
        apply: (text, renderer: RenderContext) => {
            return text.replace(/\\([%#&])/g, (_match, char) => {
                const entity = char === '&' ? '&amp;' : char === '#' ? '&#35;' : '&#37;';
                return renderer.protectHtml('raw', entity);
            });
        }
    },

    {
        name: 'latex_quotes',
        priority: 100,
        apply: (text, renderer: RenderContext) => {
            const quote = (html: string) => renderer.protectHtml('quote', html);
            const wrap = (content: string, open: string, close: string) => `${quote(open)}${content}${quote(close)}`;
            let processed = text.replace(/``([\s\S]*?)''/g, (_match, content) => wrap(content, '&ldquo;', '&rdquo;'));
            processed = processed.replace(/`([\s\S]*?)'/g, (_match, content) => wrap(content, '&lsquo;', '&rsquo;'));
            processed = processed.replace(/``/g, () => quote('&ldquo;'));
            processed = processed.replace(/`/g, () => quote('&lsquo;'));
            return processed;
        }
    },

    {
        name: 'latex_special_spaces',
        priority: 119,
        apply: (text, renderer: RenderContext) => {
            return text.replace(/~/g, () => renderer.protectHtml('space', '&nbsp;'));
        }
    },

    {
        name: 'latex_links',
        priority: 115,
        apply: (text, renderer: RenderContext) => replaceLatexLinkCommands(text, renderer)
    },

    {
        name: 'minipage',
        priority: 117,
        apply: (text, renderer: RenderContext) => {
            // Convert LaTeX width specifications to CSS widths.
            // \textwidth, \linewidth, \columnwidth → percentage of container.
            // Examples:
            //   0.54\textwidth → 54%
            //   0.5\linewidth → 50%
            //   3cm → 3cm (pass through)
            //   100pt → 100pt (pass through)
            const latexWidthToCss = (raw: string): string => {
                const w = raw.trim();
                // Match: <number><LaTeX-length-unit>
                const m = w.match(/^([0-9]*\.?[0-9]+)\s*\\(textwidth|linewidth|columnwidth|hsize)$/);
                if (m) {
                    const pct = (parseFloat(m[1]) * 100).toFixed(1).replace(/\.0$/, '');
                    return `${pct}%`;
                }
                // Bare \textwidth (no multiplier) → 100%
                if (/^\\(textwidth|linewidth|columnwidth|hsize)$/.test(w)) {
                    return '100%';
                }
                // Pass through CSS-compatible units (cm, mm, pt, em, ex, in, px, %).
                if (/^[0-9]*\.?[0-9]+\s*(cm|mm|pt|em|ex|in|px|%)?$/.test(w)) {
                    return w.replace(/\s+/g, '') || '100%';
                }
                // Fallback: try to strip LaTeX command parts
                return w.replace(/\\[a-zA-Z]+/g, '').trim() || 'auto';
            };

            // Use brace-balanced parser to handle nested minipages and complex content.
            // Walk text, find \begin{minipage}, parse optional args + width, then find matching \end{minipage}.
            let result = '';
            let cursor = 0;
            const beginRe = /\\begin\{minipage\}/g;
            let bMatch: RegExpExecArray | null;

            while ((bMatch = beginRe.exec(text)) !== null) {
                let pos = bMatch.index + bMatch[0].length;
                // Skip optional [pos]
                let vAlignSpec: string | undefined;
                if (text[pos] === '[') {
                    const close = text.indexOf(']', pos);
                    if (close === -1) { continue; }
                    vAlignSpec = text.substring(pos + 1, close).trim();
                    pos = close + 1;
                }
                // Skip optional [height]
                if (text[pos] === '[') {
                    const close = text.indexOf(']', pos);
                    if (close === -1) { continue; }
                    pos = close + 1;
                }
                // Required {width}
                if (text[pos] !== '{') { continue; }
                let depth = 1;
                const widthStart = pos + 1;
                let i = widthStart;
                while (i < text.length && depth > 0) {
                    if (text[i] === '\\') { i += 2; continue; }
                    if (text[i] === '{') { depth++; }
                    else if (text[i] === '}') { depth--; }
                    i++;
                }
                if (depth !== 0) { continue; }
                const width = text.substring(widthStart, i - 1);
                let bodyStart = i;

                // Find matching \end{minipage} accounting for nesting
                let bodyEnd = -1;
                let nestDepth = 1;
                const envRe = /\\(begin|end)\{minipage\}/g;
                envRe.lastIndex = bodyStart;
                let envMatch: RegExpExecArray | null;
                while ((envMatch = envRe.exec(text)) !== null) {
                    if (envMatch[1] === 'begin') { nestDepth++; }
                    else {
                        nestDepth--;
                        if (nestDepth === 0) {
                            bodyEnd = envMatch.index;
                            envRe.lastIndex = envMatch.index + envMatch[0].length;
                            break;
                        }
                    }
                }
                if (bodyEnd === -1) { continue; }

                const bodyContent = text.substring(bodyStart, bodyEnd);
                const endPos = envRe.lastIndex;

                // Append text before the minipage
                result += text.substring(cursor, bMatch.index);

                const vAlign = vAlignSpec === 't' ? 'top' : vAlignSpec === 'b' ? 'bottom' : 'middle';
                const cssWidth = latexWidthToCss(width);

                // Use protectHtml for opening/closing tags so the body still flows
                // through Markdown-it and gets its citations/refs/math processed.
                const openTag = renderer.protectHtml(
                    'minipage-open',
                    `<div class="latex-minipage" style="display:inline-block; vertical-align:${vAlign}; width:${cssWidth}; box-sizing:border-box; padding:0 0.3em;">`
                );
                const closeTag = renderer.protectHtml('minipage-close', '</div>');
                result += `\n\n${openTag}\n\n${bodyContent.trim()}\n\n${closeTag}\n\n`;

                cursor = endPos;
                beginRe.lastIndex = endPos;
            }
            result += text.substring(cursor);
            return result;
        }
    },

    createFigureRule(),
    createAlgorithmRule(),
    createTableRule(),

    {
        name: 'center_environment',
        priority: 118,
        apply: (text) => {
            // Strip \begin{center} and \end{center}, leaving content intact
            // (bare_includegraphics at priority 121 will process any images inside)
            text = text.replace(/\\begin\{center\}/g, '');
            text = text.replace(/\\end\{center\}/g, '');
            return text;
        }
    },

    {
        name: 'bare_includegraphics',
        priority: 121,
        apply: (text, renderer: RenderContext) => {
            // Handle \includegraphics that appears outside figure/table/algorithm environments
            // (common in beamer frames). The figure rule (priority 120) has already consumed
            // \includegraphics inside figure environments, so this only processes bare ones.
            return text.replace(/\\includegraphics(?:\[([^\]]*)\])?\s*\{([^}]+)\}/g, (_match, _options, imgPath) => {
                const cleanPath = imgPath.trim();
                const safePath = escapeHtmlAttribute(cleanPath);
                const canvasId = `pdf-${Math.random().toString(36).substr(2, 9)}`;
                if (cleanPath.toLowerCase().endsWith('.pdf')) {
                    return `\n\n${renderer.protectHtml('img', `<canvas id="${canvasId}" data-req-path="${safePath}" style="width:100%; max-width:100%; height:auto; display:block; margin:0 auto;"></canvas>`)}\n\n`;
                }
                return `\n\n${renderer.protectHtml('img', `<img src="LOCAL_IMG:${safePath}" style="max-width:100%; display:block; margin:0 auto;">`)}\n\n`;
            });
        }
    },

    {
        name: 'beamer_overlay_strip',
        priority: 125,
        apply: (text) => {
            // Strip overlay specs attached to LaTeX commands: \item<1->, \item<+->
            text = text.replace(/\\item\s*<[^>]*>/g, '\\item');
            // Strip \only<...>{ — keep content (static preview)
            text = text.replace(/\\only\s*<[^>]*>\{/g, '\\only{');
            // Strip \onslide<...> — keep content
            text = text.replace(/\\onslide\s*<[^>]*>/g, '');
            // Strip \visible<...>{ — keep content
            text = text.replace(/\\visible\s*<[^>]*>\{/g, '\\visible{');
            // Strip \invisible<...>{ — keep content
            text = text.replace(/\\invisible\s*<[^>]*>\{/g, '\\invisible{');
            // Strip \uncover<...>{ — keep content
            text = text.replace(/\\uncover\s*<[^>]*>\{/g, '\\uncover{');
            // Strip \pause command
            text = text.replace(/\\pause\b/g, '');
            return text;
        }
    },

    {
        name: 'beamer_frame',
        priority: 135,
        apply: (text, renderer: RenderContext) => {
            // Step 1: Render \section[short]{Long}\n\makesectionpage as a section divider page.
            // Use a placeholder so this content survives the frame wrapping below.
            const placeholders: { token: string; html: string }[] = [];
            const placeholderId = (idx: number) => `SNAPTEX_SECPAGE_${idx}_`;

            const sectionPageRegex = /\\section(?:\[[^\]]*\])?\s*\{((?:[^{}]|\{[^{}]*\})*)\}(?:\s*\\label\s*\{[^}]+\})?\s*\\makesectionpage\b/g;
            text = text.replace(sectionPageRegex, (_match, title) => {
                const safeTitle = renderer.renderInline(
                    resolveLatexStyles(title.trim(), html => renderer.protectHtml('style', html))
                );
                const html = renderer.protectHtml('secpage', `<div class="beamer-frame beamer-section-page"><div class="beamer-section-page-inner"><div class="beamer-section-page-title">${safeTitle}</div></div></div>`);
                const idx = placeholders.length;
                placeholders.push({ token: placeholderId(idx), html: `\n\n${html}\n\n` });
                return placeholderId(idx);
            });

            // Standalone \makesectionpage (no preceding \section) — empty section page.
            text = text.replace(/\\makesectionpage\b/g, () => {
                const html = renderer.protectHtml('secpage', '<div class="beamer-frame beamer-section-page"><div class="beamer-section-page-inner"></div></div>');
                const idx = placeholders.length;
                placeholders.push({ token: placeholderId(idx), html: `\n\n${html}\n\n` });
                return placeholderId(idx);
            });

            // \sectionpage (rare in user code)
            text = text.replace(/\\sectionpage\b/g, () => {
                const html = renderer.protectHtml('secpage', '<div class="beamer-section-page"><div class="beamer-section-page-inner"></div></div>');
                const idx = placeholders.length;
                placeholders.push({ token: placeholderId(idx), html: html });
                return placeholderId(idx);
            });

            // \thankspage{Thanks}
            text = text.replace(/\\thankspage\s*\{([^}]*)\}/g, (_match, thanksText) => {
                const safe = escapeHtml(thanksText.trim());
                const html = renderer.protectHtml('thanks', `<div class="beamer-frame beamer-thanks-page"><span>${safe}</span></div>`);
                const idx = placeholders.length;
                placeholders.push({ token: placeholderId(idx), html: `\n\n${html}\n\n` });
                return placeholderId(idx);
            });

            // Step 2: Frame processing
            const hasFrame = /\\begin\{frame\}/.test(text) || /\\end\{frame\}/.test(text);
            if (hasFrame) {
                let frameTitle = '';
                const ftMatch = text.match(/\\frametitle\s*\{((?:[^{}]|\{[^{}]*\})*)\}/);
                if (ftMatch) {
                    const titleContent = renderer.renderInline(
                        resolveLatexStyles(ftMatch[1], html => renderer.protectHtml('style', html))
                    );
                    frameTitle = `<div class="beamer-frame-title">${titleContent}</div>`;
                    text = text.replace(ftMatch[0], '');
                }

                text = text.replace(/\\begin\{frame\}(?:\[[^\]]*\])?/g, '');
                text = text.replace(/\\end\{frame\}/g, '');

                text = text.replace(/\\tableofcontents\b/g, () => {
                    return renderer.protectHtml('toc', '<div class="beamer-toc-placeholder">Table of Contents</div>');
                });

                const openTag = renderer.protectHtml('frame-open', '<div class="beamer-frame">');
                const closeTag = renderer.protectHtml('frame-close', '</div>');
                const titlePart = frameTitle ? renderer.protectHtml('frametitle', frameTitle) : '';

                text = `\n\n${openTag}${titlePart}\n\n${text.trim()}\n\n${closeTag}\n\n`;
            }

            // Step 3: Restore placeholders OUTSIDE any frame wrapper.
            // Each section page / thanks page becomes a sibling of the frame, not a child.
            for (const { token, html } of placeholders) {
                text = text.replace(token, html);
            }

            return text;
        }
    },

    {
        name: 'beamer_blocks',
        priority: 145,
        apply: (text, renderer: RenderContext) => {
            const blockRegex = new RegExp(
                `\\\\begin\\{(${REGEX_STR.BEAMER_BLOCK_ENVS})\\}\\s*\\{((?:[^{}]|\\{[^{}]*\\})*)\\}([\\s\\S]*?)\\\\end\\{\\1\\}`,
                'gi'
            );
            return text.replace(blockRegex, (_match, envName, title, content) => {
                const blockClass = envName === 'block' ? 'beamer-block' :
                    envName === 'alertblock' ? 'beamer-alertblock' : 'beamer-exampleblock';
                const safeTitle = renderer.renderInline(
                    resolveLatexStyles(title.trim(), html => renderer.protectHtml('style', html))
                );
                // Split open/close tags so body content (including \\, \cite, math)
                // continues through the rule pipeline (latex_linebreak, citations, etc.).
                const openOuter = renderer.protectHtml(`${envName}-open`, `<div class="${blockClass}"><div class="beamer-block-title">${safeTitle}</div><div class="beamer-block-body">`);
                const closeOuter = renderer.protectHtml(`${envName}-close`, `</div></div>`);
                return `\n\n${openOuter}\n\n${content.trim()}\n\n${closeOuter}\n\n`;
            });
        }
    },

    {
        name: 'theorems_and_proofs',
        priority: 150,
        apply: (text, renderer: RenderContext) => {
            const thmBeginRegex = new RegExp(`\\\\begin\\{(${REGEX_STR.THEOREM_ENVS})\\}(?:\\{.*?\\})?(?:\\[(.*?)\\])?`, 'gi');

            text = text.replace(thmBeginRegex, (_match, envName, optArg) => {
                const displayName = getTheoremDisplayName(envName);
                let header = `<span class="latex-thm-head"><strong class="latex-theorem-header">${displayName} <span class="sn-cnt" data-type="thm"></span>`;
                if (optArg) {
                    header += `</strong>&nbsp;(${escapeHtml(optArg)}).</span>&nbsp; `;
                } else {
                    header += `.</strong></span>&nbsp; `;
                }
                return `\n\n${renderer.protectHtml('thm-open', `<div class="latex-theorem">${header}`)}\n\n`;
            });

            const thmEndRegex = new RegExp(`\\\\end\\{(${REGEX_STR.THEOREM_ENVS})\\}`, 'gi');
            text = text.replace(thmEndRegex, () => `\n\n${renderer.protectHtml('thm-close', '</div>')}\n\n`);

            text = text.replace(/\\begin\{proof\}(?:\[(.*?)\])?/gi, (_match, optArg) => {
                const title = optArg ? `Proof (${escapeHtml(optArg)}).` : `Proof.`;
                return `\n${renderer.protectHtml('raw', '<span class="no-indent-marker"></span>')}**${title}** `;
            });
            return text.replace(/\\end\{proof\}/gi, () => ` ${renderer.protectHtml('raw', '<span style="float:right;">QED</span>')}\n`);
        }
    },

    {
        name: 'maketitle_and_abstract',
        priority: 160,
        apply: (text, renderer: RenderContext) => {
            if (text.includes('\\maketitle')) {
                let titleBlock = '';
                const metadata = renderer.metadata;
                const processMeta = (value: string | undefined) => renderInlineLatexHtml(value, tex => renderMath(tex, false, renderer));

                const safeTitle = processMeta(metadata?.title);
                const safeAuthors = renderMaketitleAuthorsHtml(
                    metadata?.authors ?? [],
                    metadata?.affiliations ?? [],
                    processMeta
                );
                const safeDate = processMeta(metadata?.date);
                const safeEditor = processMeta(metadata?.custom.editor);

                if (safeTitle) { titleBlock += `<h1 class="latex-title">${safeTitle}</h1>`; }
                if (safeAuthors) { titleBlock += safeAuthors; }
                if (safeEditor) { titleBlock += `<div class="latex-editor"><strong>Editor:</strong> ${safeEditor}</div>`; }
                if (safeDate) { titleBlock += `<div class="latex-date">${safeDate}</div>`; }

                text = text.replace(/\\maketitle.*/g, `\n\n` + renderer.protectHtml('meta', titleBlock) + `\n\n`);
                text = text.replace(/ \[meta:.*?\]/g, '');
            }

            text = text.replace(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/gi, (_match, content) => abstractSentinel(content));
            text = replaceLatexCommandCalls(text, [
                {
                    name: ['Abstract', 'abstract'],
                    requiredArgs: 1,
                    render: call => abstractSentinel(call.requiredArgs[0].content)
                },
                {
                    name: ['Keywords', 'keywords', 'Keyword', 'keyword'],
                    requiredArgs: 1,
                    render: call => keywordsSentinel(call.requiredArgs[0].content)
                }
            ]);

            const keywordsRegex = /(?:\\begin\{keywords?\}([\s\S]*?)\\end\{keywords?\}|\\noindent\{\\bf Keywords\}:\s*(.*))/gi;
            text = text.replace(keywordsRegex, (_match, contentA, contentB) => keywordsSentinel(contentA || contentB || ''));

            return text;
        }
    },

    {
        name: 'sections',
        priority: 170,
        apply: (text, renderer: RenderContext) => {
            const sectionRegex = new RegExp(`\\\\(${REGEX_STR.SECTION_LEVELS})(\\*?)\\{((?:[^{}]|{[^{}]*})*)\\}\\s*(\\\\label\\{[^}]+\\})?\\s*`, 'g');

            return text.replace(sectionRegex, (_match, level, star, content, label) => {
                let prefix = '##';
                if (level === 'subsection') { prefix = '###'; }
                else if (level === 'subsubsection') { prefix = '####'; }
                else if (level === 'paragraph') { prefix = '#####'; }
                else if (level === 'subparagraph') { prefix = '######'; }

                let numHtml = "";
                if (star !== '*' && !['paragraph', 'subparagraph'].includes(level)) {
                    numHtml = `<span class="sn-cnt" data-type="sec"></span>. `;
                }

                let anchor = "";
                if (label) {
                    const labelName = label.match(/\{([^}]+)\}/)?.[1] || "";
                    anchor = createHiddenLabelAnchor(labelName);
                }
                if(anchor) {anchor = renderer.protectHtml('anchor', anchor);}
                if(numHtml) {numHtml = renderer.protectHtml('secnum', numHtml);}

                return `\n${prefix} ${numHtml}${content.trim()} ${anchor}\n`;
            });
        }
    },

    {
        name: 'lists',
        priority: 180,
        apply: (text, renderer: RenderContext) => renderLatexLists(text, renderer)
    },

    {
        name: 'text_styles',
        priority: 190,
        apply: (text, renderer: RenderContext) => {
            return resolveLatexStyles(text, createStyleHtmlProtector(renderer));
        }
    }
];

export const DEFAULT_BLOCK_DEPENDENCY_RULES: BlockDependencyRule[] = [
    {
        name: 'maketitle',
        collect: ({ text, artifact, deps }) => {
            const hasMaketitle = artifact
                ? artifact.metadata.macros.includes('maketitle')
                : text.includes('\\maketitle');
            if (!hasMaketitle) { return []; }
            return [
                deps.metadata('title'),
                deps.metadata('date'),
                deps.metadata('authors'),
                deps.metadata('affiliations'),
                deps.metadata('custom.editor')
            ];
        }
    },
    {
        name: 'bibliography',
        collect: ({ text, artifact, deps }) => {
            const hasBibliography = artifact
                ? artifact.metadata.macros.includes('bibliography') || artifact.metadata.macros.includes('printbibliography')
                : R_BIBLIOGRAPHY.test(text) || R_ADDBIBRESOURCE.test(text) || /\\printbibliography\b/.test(text);
            if (!hasBibliography) { return []; }
            return [deps.citedKeys()];
        }
    }
];

export const SNAP_TEX_RULES = defineRuleRegistry({
    metadataExtractors: [
        BUILTIN_METADATA_EXTRACTOR,
        EDITOR_METADATA_EXTRACTOR
    ],
    renderRules: DEFAULT_RENDER_RULES,
    astRenderRules: DEFAULT_AST_RENDER_RULES,
    blockDependencyRules: DEFAULT_BLOCK_DEPENDENCY_RULES,
    splitterConfig: DEFAULT_SPLITTER_CONFIG,
    splitterRules: DEFAULT_SPLITTER_RULES
});

export function postProcessHtml(html: string): string {
    html = html.replace(/<p>\s*OOABSTRACT_STARTOO\s*<\/p>/g, '<div class="latex-abstract"><span class="latex-abstract-title">Abstract</span>');
    html = html.replace(/OOABSTRACT_STARTOO/g, '<div class="latex-abstract"><span class="latex-abstract-title">Abstract</span>');
    html = html.replace(/<p>\s*OOABSTRACT_ENDOO\s*<\/p>/g, '</div>');
    html = html.replace(/OOABSTRACT_ENDOO/g, '</div>');
    const keywordRegex = /<p>\s*OOKEYWORDS_STARTOO([\s\S]*?)OOKEYWORDS_ENDOO\s*<\/p>/g;
    html = html.replace(keywordRegex, (_match, content) => {
        return `<div class="latex-keywords"><strong>Keywords:</strong> ${content}</div>`;
    });
    return html;
}
