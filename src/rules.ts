import {
    toRoman,
    createHiddenLabelAnchor,
    escapeHtml,
    escapeHtmlAttribute,
    extractAndHideLabels,
    splitLatexCitationKeys,
    replaceLatexCommandCalls,
    resolveLatexStyles,
    sanitizeHttpUrlForAttribute
} from './utils';
import { PreprocessRule, RenderContext } from './types';
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
    getTheoremDisplayName
} from './patterns';
import { createRefLink, renderMath } from './rule-helpers';
import { createTikzPictureRule } from './rule-tikz';
import { createAlgorithmRule, createFigureRule, createTableRule } from './rule-floats';

function renderExternalLink(rawUrl: string, safeContent: string, className: string, renderer: RenderContext): string {
    const safeHref = sanitizeHttpUrlForAttribute(rawUrl);

    if (!safeHref) {
        return renderer.protectHtml('link-text', safeContent);
    }

    return renderer.protectHtml(
        'link',
        `<a href="${safeHref}" class="latex-link ${className}" target="_blank" rel="noopener noreferrer">${safeContent}</a>`
    );
}

function replaceLatexLinkCommands(text: string, renderer: RenderContext): string {
    return replaceLatexCommandCalls(text, [
        {
            name: 'href',
            requiredArgs: 2,
            render: call => {
                const styledContent = resolveLatexStyles(call.requiredArgs[1].content, html => renderer.protectHtml('style', html));
                return renderExternalLink(call.requiredArgs[0].content, escapeHtml(styledContent), 'latex-href', renderer);
            }
        },
        {
            name: 'url',
            requiredArgs: 1,
            render: call => renderExternalLink(call.requiredArgs[0].content, escapeHtml(call.requiredArgs[0].content.trim()), 'latex-url', renderer)
        }
    ]);
}

interface CitationPart {
    error: boolean;
    key: string;
    author: string;
    year: string;
}

function normalizeRefType(type: string): 'ref' | 'eqref' {
    return type === 'eqref' ? 'eqref' : 'ref';
}

function replaceMathRefs(content: string, renderer: RenderContext): string {
    return content.replace(/\\(ref|eqref)\*?\{([^}]+)\}/g, (_match, reftype, key) => {
        return createRefLink(key, renderer, normalizeRefType(reftype));
    });
}

/**
 * Ordered LaTeX-to-Markdown preprocessing pipeline.
 *
 * Rules consume small LaTeX constructs before Markdown-it runs. Any generated
 * HTML must go through RenderContext.protectHtml so Markdown-it cannot escape
 * or expose it as user-visible text.
 */
export const DEFAULT_PREPROCESS_RULES: PreprocessRule[] = [
    {
        name: 'clean_comments',
        priority: 5,
        apply: (text) => {
            return text
                .replace(/^[ \t]*%.*(?:\r?\n|$)/gm, '')
                .replace(/(?<!\\)%.*(\r?\n)?/g, '');
        }
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
            text = text.replace(/\\(Rmnum|rmnum|romannumeral)\s*\{?(\d+)\}?/g, (_match, cmd, numStr) => {
                return toRoman(parseInt(numStr), cmd === 'Rmnum');
            });
            return text;
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
                    if (renderer.mathRenderer === 'mathjax') {
                        // MathJax natively supports align/gather/equation/etc.
                        // Pass the original environment back so MathJax handles it.
                        finalMath = `\\begin{${name}${star || ''}}\n${finalMath}\n\\end{${name}${star || ''}}`;
                    } else {
                        // KaTeX doesn't support align as a top-level env; wrap in aligned/gathered.
                        if (['align', 'flalign', 'alignat', 'multline'].includes(name)) {
                            finalMath = `\\begin{aligned}\n${finalMath}\n\\end{aligned}`;
                        } else if (name === 'gather') {
                            finalMath = `\\begin{gathered}\n${finalMath}\n\\end{gathered}`;
                        }
                    }
                }

                const protectedTag = renderMath(finalMath, true, renderer);

                const afterMatch = fullString.substring(offset + match.length);
                const isFollowedByText = /^\s*\S/.test(afterMatch) && !/^\s*\n\n/.test(afterMatch);

                const hiddenLabels = hiddenHtml ? renderer.protectHtml('raw', hiddenHtml) : '';
                let result = protectedTag + hiddenLabels;
                if (eqNumHTML) {
                    result = renderer.protectHtml('math-block', `<div class="equation-container" style="position: relative; width: 100%;">
                                ${protectedTag}
                                <span class="eq-no" style="position: absolute; right: 0; top: 50%; transform: translateY(-50%); pointer-events: none;">
                                    ${eqNumHTML}
                                </span>
                            </div>${hiddenLabels}`);
                }
                return result + (isFollowedByText ? renderer.protectHtml('raw', '<span class="no-indent-marker"></span>') : '');
            });
        }
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
        name: 'expand_text_macros',
        priority: 55,
        apply: (text, renderer: RenderContext) => {
            const macros = renderer.currentMacros;
            const names: string[] = [];
            for (const [name, body] of Object.entries(macros)) {
                if (!name.startsWith('\\')) { continue; }
                if (/#\d/.test(body)) { continue; }
                if (!/^\\[a-zA-Z@]+$/.test(name)) { continue; }
                names.push(name);
            }
            if (names.length === 0) { return text; }

            names.sort((a, b) => b.length - a.length);
            const namePattern = names.map(n => n.slice(1)).join('|');
            const re = new RegExp(`\\\\(${namePattern})(?![a-zA-Z@])`, 'g');

            return text.replace(re, (match, name) => {
                const expansion = macros['\\' + name];
                return expansion !== undefined ? expansion : match;
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
                const labelArray = labels.split(',').map((l: string) => l.trim());
                const htmlLinks = labelArray.map((label: string) => {
                    const safeLabel = escapeHtmlAttribute(label);
                    return `<a href="#${safeLabel}" class="latex-link latex-ref sn-ref" data-key="${safeLabel}">?</a>`;
                });
                const joinedLinks = htmlLinks.join(', ');
                const result = (type === 'eqref') ? `(${joinedLinks})` : joinedLinks;
                return renderer.protectHtml('ref', result);
            });

            // \cref / \Cref (cleveref). Prefix is inferred from the label key
            // ("eq:"/"fig:"/"tbl:"/"sec:"/"alg:"/"thm:"). \Cref capitalises.
            const crefPrefix = (key: string, capitalised: boolean): string => {
                const head = key.split(':', 1)[0].toLowerCase();
                const map: Record<string, [string, string]> = {
                    eq: ['eq.', 'Eq.'],
                    equation: ['eq.', 'Eq.'],
                    fig: ['fig.', 'Fig.'],
                    figure: ['fig.', 'Fig.'],
                    tbl: ['table', 'Table'],
                    tab: ['table', 'Table'],
                    table: ['table', 'Table'],
                    sec: ['sec.', 'Sec.'],
                    section: ['sec.', 'Sec.'],
                    chap: ['chap.', 'Chap.'],
                    chapter: ['chap.', 'Chap.'],
                    alg: ['alg.', 'Alg.'],
                    algorithm: ['alg.', 'Alg.'],
                    thm: ['thm.', 'Thm.'],
                    theorem: ['thm.', 'Thm.'],
                    lem: ['lemma', 'Lemma'],
                    lemma: ['lemma', 'Lemma'],
                    cor: ['cor.', 'Cor.'],
                    prop: ['prop.', 'Prop.']
                };
                const entry = map[head];
                if (!entry) { return ''; }
                return (capitalised ? entry[1] : entry[0]) + ' ';
            };

            const renderCrefLink = (label: string): string => {
                const safe = escapeHtmlAttribute(label);
                return `<a href="#${safe}" class="latex-link latex-ref sn-ref" data-key="${safe}">?</a>`;
            };

            text = text.replace(R_CREF, (_match, cmd, labels) => {
                const capital = cmd === 'Cref';
                const labelArray = labels.split(',').map((l: string) => l.trim()).filter(Boolean);
                if (labelArray.length === 0) { return ''; }
                const prefix = crefPrefix(labelArray[0], capital);
                const linked = labelArray.map(renderCrefLink).join(', ');
                return renderer.protectHtml('cref', prefix + linked);
            });

            text = text.replace(R_CREFRANGE, (_match, cmd, a, b) => {
                const capital = cmd === 'Crefrange';
                const labelA = a.trim(), labelB = b.trim();
                const prefix = crefPrefix(labelA, capital);
                const dash = '–';
                return renderer.protectHtml('cref', prefix + renderCrefLink(labelA) + dash + renderCrefLink(labelB));
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
                const safePre = escapeHtml(pre);
                const safePost = escapeHtml(post);

                const parts: CitationPart[] = keyArray.map((key: string) => {
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

                let finalHtml = "";
                if (cmd === 'citet') {
                    const formatted = parts.map((part, i) => {
                        const isLast = i === parts.length - 1;
                        if (part.error) { return renderYearText(part, isLast); }
                        return `${part.author} (${renderYearText(part, isLast)})`;
                    }).join(', ');
                    finalHtml = safePre + formatted;
                } else if (cmd === 'citeyear') {
                    const formatted = parts.map((part, i) => {
                        return renderYearText(part, i === parts.length - 1);
                    }).join(', ');
                    finalHtml = safePre + formatted;
                } else {
                    const inner = parts.map((part) => {
                        if (part.error) { return `[${escapeHtml(part.key)}?]`; }
                        return mkLink(`${part.author}, ${part.year}`, part.key);
                    }).join('; ');
                    let content = inner;
                    if (safePre) { content = safePre + content; }
                    if (safePost) { content = content + ', ' + safePost; }
                    finalHtml = `(${content})`;
                }

                return renderer.protectHtml('cite', finalHtml);
            });
            return text;
        }
    },

    {
        name: 'bibliography',
        priority: 71,
        apply: (text, renderer: RenderContext) => {
            text = text.replace(R_BIBLIOGRAPHY_STYLE, '');

            // Strip \addbibresource (already processed in document loading)
            text = text.replace(R_ADDBIBRESOURCE, '');

            // Render bibliography function
            const renderBibliography = () => {
                if (renderer.citedKeys.length === 0) {
                    return renderer.protectHtml('bib', `<div class="latex-bibliography error">No citations found.</div>`);
                }
                const uniqueKeys = Array.from(new Set(renderer.citedKeys));
                const sortedKeys = uniqueKeys.sort((a, b) => {
                    const entryA = renderer.bibEntries.get(a);
                    const entryB = renderer.bibEntries.get(b);
                    const authA = entryA ? (entryA.fields.author || '') : '';
                    const authB = entryB ? (entryB.fields.author || '') : '';
                    return authA.localeCompare(authB);
                });

                let html = `<h2 class="latex-bibliography-header">References</h2><div class="latex-bibliography-list">`;
                sortedKeys.forEach((key) => {
                    const entry = renderer.bibEntries.get(key);
                    const content = entry
                        ? BibTexParser.formatEntry(entry, renderer)
                        : `<span style="color:red">Bib entry '${escapeHtml(key)}' not found.</span>`;
                    const safeKey = escapeHtmlAttribute(key);
                    html += `<div class="bib-item" id="ref-${safeKey}" style="margin-bottom: 0.8em; padding-left: 2em; text-indent: -2em;">${content}</div>`;
                });
                html += `</div>`;
                return renderer.protectHtml('bib', html);
            };

            // Handle bibtex \bibliography{ref}
            text = text.replace(new RegExp(R_BIBLIOGRAPHY, 'g'), renderBibliography);

            // Handle biblatex \printbibliography
            text = text.replace(/\\printbibliography\b/g, renderBibliography);

            return text;
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
            const placeholderId = (idx: number) => ` SECPAGE_${idx} `;

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
            const thmRegex = new RegExp(`\\\\begin\\{(${REGEX_STR.THEOREM_ENVS})\\}(?:\\{.*?\\})?(?:\\[(.*?)\\])?([\\s\\S]*?)\\\\end\\{\\1\\}`, 'gi');

            text = text.replace(thmRegex, (_match, envName, optArg, content) => {
                const displayName = getTheoremDisplayName(envName);

                let header = `<span class="latex-thm-head"><strong class="latex-theorem-header">${displayName} <span class="sn-cnt" data-type="thm"></span>`;

                if (optArg) {
                    header += `</strong>&nbsp;(${escapeHtml(optArg)}).</span>&nbsp; `;
                } else {
                    header += `.</strong></span>&nbsp; `;
                }

                let body = resolveLatexStyles(content.trim(), html => renderer.protectHtml('style', html));
                body = escapeHtml(body);
                return `\n\n${renderer.protectHtml('thm', `<div class="latex-theorem">${header}${body}</div>`)}\n\n`;
            });

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
                const meta = renderer.document?.metadata;

                const processMeta = (val: string | undefined) => {
                    if (!val) {return '';}
                    const lineBreakToken = renderer.protectHtml('meta-br', '<br/>');
                    let res = val.replace(/<br\s*\/?>/gi, lineBreakToken);
                    res = res.replace(/\\\\/g, lineBreakToken);
                    res = res.replace(/\$((?:\\.|[^\\$])+?)\$/g, (_m: string, c: string) => renderMath(c.trim(), false, renderer));
                    res = resolveLatexStyles(res, html => renderer.protectHtml('style', html));
                    res = escapeHtml(res);
                    return res;
                };

                const safeTitle = processMeta(meta?.title);
                const safeSubtitle = processMeta(meta?.subtitle);
                const safeAuthor = processMeta(meta?.author);
                const safeInstitute = processMeta(meta?.institute);
                const safeAffiliation = processMeta(meta?.affiliation);
                const safeDate = processMeta(meta?.date);

                if (safeTitle) { titleBlock += `<h1 class="latex-title">${safeTitle}</h1>`; }
                if (safeSubtitle) { titleBlock += `<div class="latex-subtitle">${safeSubtitle}</div>`; }
                if (safeAuthor) { titleBlock += `<div class="latex-author">${safeAuthor}</div>`; }
                if (safeInstitute) { titleBlock += `<div class="latex-institute">${safeInstitute}</div>`; }
                if (safeAffiliation) { titleBlock += `<div class="latex-affiliation">${safeAffiliation}</div>`; }
                if (safeDate) { titleBlock += `<div class="latex-date">${safeDate}</div>`; }

                text = text.replace(/\\maketitle.*/g, `\n\n` + renderer.protectHtml('meta', titleBlock) + `\n\n`);
                text = text.replace(/ \[meta:.*?\]/g, '');
            }

            text = text.replace(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/gi, (_match, content) => {
                return `\n\nOOABSTRACT_STARTOO\n\n${content.trim()}\n\nOOABSTRACT_ENDOO\n\n`;
            });

            const keywordsRegex = /(?:\\begin\{keywords?\}([\s\S]*?)\\end\{keywords?\}|\\noindent\{\\bf Keywords\}:\s*(.*))/gi;
            text = text.replace(keywordsRegex, (_match, contentA, contentB) => {
                const content = (contentA || contentB || '').trim();
                return `\n\nOOKEYWORDS_STARTOO${content}OOKEYWORDS_ENDOO\n\n`;
            });

            return text;
        }
    },

    {
        name: 'sections',
        priority: 170,
        apply: (text, renderer: RenderContext) => {
            // Supports both \section{Title} and \section[Short]{Long}
            const sectionRegex = new RegExp(`\\\\(${REGEX_STR.SECTION_LEVELS})(\\*?)(?:\\[[^\\]]*\\])?\\{((?:[^{}]|{[^{}]*})*)\\}\\s*(\\\\label\\{[^}]+\\})?\\s*`, 'g');

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
        apply: (text) => {
            const listStack: string[] = [];
            return text.replace(/(\\begin\{(?:itemize|enumerate)\})|(\\end\{(?:itemize|enumerate)\})|(\\item(?:\[(.*?)\])?)/g, (match, pBegin, pEnd, pItem, pLabel) => {
                if (pBegin) {
                    listStack.push(match.includes('itemize') ? 'ul' : 'ol');
                    return '\n\n';
                } else if (pEnd) {
                    listStack.pop();
                    return '\n\n';
                } else if (pItem) {
                    const depth = listStack.length;
                    const indent = '  '.repeat(Math.max(0, depth - 1));
                    const currentType = listStack[listStack.length - 1] || 'ul';
                    if (pLabel) { return `\n${indent}- **${pLabel}** `; }
                    return `\n${indent}${currentType === 'ul' ? '-' : '1.'} `;
                }
                return match;
            });
        }
    },

    {
        name: 'latex_linebreak',
        priority: 185,
        apply: (text, renderer: RenderContext) => {
            // Convert LaTeX line break \\ (or \\[length]) to HTML <br/>.
            // By this priority (185), all math envs ($..$, $$..$$, \[..\],
            // equation/align/etc.) and tables/figures are already protected
            // into XSNAP tokens. Anything still containing literal \\ is
            // genuine line-break text (in minipages, blocks, frame body).
            return text.replace(/\\\\(?:\s*\[[^\]]*\])?/g, () => renderer.protectHtml('br', '<br/>'));
        }
    },

    {
        name: 'text_styles',
        priority: 190,
        apply: (text, renderer: RenderContext) => {
            return resolveLatexStyles(text, html => renderer.protectHtml('style', html));
        }
    }
];

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
