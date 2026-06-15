import { PreprocessRule, RenderContext } from './types';
import { escapeHtmlAttribute, extractAndHideLabels, findCommand, resolveLatexStyles } from './utils';
import { recoverPreservedTokens, renderCaptionContent, unwrapResizeboxAroundProtectedContent } from './rule-helpers';
import { findFirstTabularEnvironment, renderLatexTabular, renderLatexTableInlineContent } from './latex-table';

interface FloatCaptionConfig {
    className: string;
    label: string;
    counterType: 'fig' | 'alg' | 'tbl';
}

function replaceFloatEnvironment(text: string, envName: 'figure' | 'algorithm' | 'table', render: (content: string) => string): string {
    const pattern = new RegExp(`\\\\begin\\{${envName}(\\*?)\\}(?:\\[.*?\\])?([\\s\\S]*?)\\\\end\\{${envName}\\1\\}`, 'gi');
    return text.replace(pattern, (_match, _star, content) => render(content));
}

/**
 * Walks `text` looking for `\subfigure` / `\subfloat` calls and replaces each
 * with the result of `render(captionArg, body)`. Both the optional `[caption]`
 * and the mandatory `{body}` are matched with brace balancing so nested
 * braces (e.g. `\includegraphics[width=0.45\linewidth]{a.pdf}`) survive.
 * Returns the rewritten string.
 */
function extractSubfigureCalls(
    text: string,
    render: (captionArg: string | undefined, body: string) => string
): string {
    const re = /\\(?:subfigure|subfloat)\b/g;
    let out = '';
    let cursor = 0;
    let m: RegExpExecArray | null;

    const readBalanced = (open: string, close: string, from: number): { content: string; end: number } | null => {
        if (text[from] !== open) { return null; }
        let depth = 0;
        for (let i = from; i < text.length; i++) {
            const ch = text[i];
            if (ch === '\\') { i++; continue; }
            if (ch === open) { depth++; continue; }
            if (ch === close) {
                depth--;
                if (depth === 0) {
                    return { content: text.substring(from + 1, i), end: i + 1 };
                }
            }
        }
        return null;
    };

    while ((m = re.exec(text)) !== null) {
        let p = m.index + m[0].length;
        // optional [caption]
        let captionArg: string | undefined;
        // optional [width] preceding the caption is uncommon; subfigure spec is `\subfigure[caption]{body}`.
        const optMatch = readBalanced('[', ']', p);
        if (optMatch) { captionArg = optMatch.content; p = optMatch.end; }
        // mandatory {body}
        const bodyMatch = readBalanced('{', '}', p);
        if (!bodyMatch) { continue; }
        out += text.substring(cursor, m.index) + render(captionArg, bodyMatch.content);
        cursor = bodyMatch.end;
        re.lastIndex = bodyMatch.end;
    }
    out += text.substring(cursor);
    return out;
}

function extractRenderedCaption(content: string, renderer: RenderContext, config: FloatCaptionConfig): { content: string; captionHtml: string } {
    const captionRes = findCommand(content, 'caption');
    if (!captionRes) {
        return { content, captionHtml: '' };
    }

    const captionHtml = `<div class="${config.className}"><strong>${config.label} <span class="sn-cnt" data-type="${config.counterType}"></span>:</strong> ${renderCaptionContent(captionRes.content, renderer)}</div>`;
    return {
        content: content.substring(0, captionRes.start) + content.substring(captionRes.end),
        captionHtml
    };
}

/**
 * Converts LaTeX figure environments to protected HTML, preserving captions,
 * labels, local images, PDF canvases, and nested protected TikZ content.
 */
export function createFigureRule(): PreprocessRule {
    return {
        name: 'figure',
        priority: 120,
        apply: (text: string, renderer: RenderContext) => {
            return replaceFloatEnvironment(text, 'figure', content => {
                const extracted = extractRenderedCaption(content, renderer, { className: 'figure-caption', label: 'Figure', counterType: 'fig' });
                let body = extracted.content;
                const captionHtml = extracted.captionHtml;

                const { cleanContent, hiddenHtml } = extractAndHideLabels(body);
                body = cleanContent;

                body = body.trim().replace(/\\centering/g, '');
                body = unwrapResizeboxAroundProtectedContent(body);

                // Old-style \subfigure[caption]{body} from the `subfigure`
                // package. Each occurrence becomes a flex item; siblings end
                // up side-by-side under the parent figure. Counter labels
                // (a)/(b)/... are handed out in document order.
                let subIndex = 0;
                body = extractSubfigureCalls(body, (capArg, innerBody) => {
                    const letter = String.fromCharCode(97 + (subIndex++ % 26));
                    const captionInner = capArg !== undefined
                        ? renderCaptionContent(capArg, renderer)
                        : '';
                    const subCaptionHtml = captionInner
                        ? `<div class="latex-subfigure-caption">(${letter}) ${captionInner}</div>`
                        : '';
                    return `<div class="latex-subfigure">${innerBody}${subCaptionHtml}</div>`;
                });

                body = body.replace(/\\includegraphics(?:\[.*?\])?\s*\{([^}]+)\}/g, (_imgMatch: string, imgPath: string) => {
                    const cleanPath = imgPath.trim();
                    const safePath = escapeHtmlAttribute(cleanPath);
                    const canvasId = `pdf-${Math.random().toString(36).substr(2, 9)}`;

                    if (cleanPath.toLowerCase().endsWith('.pdf')) {
                        return `<canvas id="${canvasId}" data-req-path="${safePath}" style="width:100%; max-width:100%; height:auto; display:block; margin:0 auto;"></canvas>`;
                    }
                    return `<img src="LOCAL_IMG:${safePath}" style="max-width:100%; display:block; margin:0 auto;">`;
                });

                const finalHtml = `<div class="latex-figure" style="text-align: center; margin: 1em 0;">${body}${captionHtml}${hiddenHtml}</div>`;
                return `\n\n${renderer.protectHtml('fig', finalHtml)}\n\n`;
            });
        }
    };
}

/**
 * Converts algorithm/algorithmic environments into compact ordered or unordered
 * HTML lists while preserving captions and labels.
 */
export function createAlgorithmRule(): PreprocessRule {
    return {
        name: 'algorithm',
        priority: 130,
        apply: (text: string, renderer: RenderContext) => {
            return replaceFloatEnvironment(text, 'algorithm', content => {
                const extracted = extractRenderedCaption(content, renderer, { className: 'alg-caption', label: 'Algorithm', counterType: 'alg' });
                content = extracted.content;
                const captionHtml = extracted.captionHtml;

                const algRegex = /\\begin\{algorithmic\}(?:\[(.*?)\])?([\s\S]*?)\\end\{algorithmic\}/g;
                let bodyHtml = '';
                let matchAlg;
                const processedRegions: {start: number, end: number}[] = [];

                while ((matchAlg = algRegex.exec(content)) !== null) {
                    processedRegions.push({start: matchAlg.index, end: matchAlg.index + matchAlg[0].length});
                    const params = matchAlg[1] || '';
                    const rawBody = matchAlg[2];
                    const showNumbers = params.includes('1');
                    const listTag = showNumbers ? 'ol' : 'ul';
                    const lines = rawBody.split('\n');
                    let listItems = '';

                    lines.forEach(line => {
                        let trimmed = line.trim();
                        if (!trimmed || trimmed.startsWith('%') || trimmed.startsWith('\\renewcommand') || trimmed.startsWith('\\setlength')) { return; }

                        let prefixHtml = "";
                        let contentToRender = trimmed;
                        let isSpecialLine = false;
                        if (trimmed.match(/^\\(Require|Ensure|Input|Output)/)) {
                            const isInput = trimmed.match(/^\\(Require|Input)/);
                            const label = isInput ? 'Input:' : 'Output:';
                            prefixHtml = `<strong>${label}</strong> `;
                            contentToRender = trimmed.replace(/^\\(Require|Ensure|Input|Output)\s*/, '');
                            isSpecialLine = true;
                        } else if (trimmed.match(/^\\State/)) {
                            contentToRender = trimmed.replace(/^\\State\s*/, '');
                            if (contentToRender.startsWith('{') && contentToRender.endsWith('}')) {
                                contentToRender = contentToRender.substring(1, contentToRender.length - 1);
                            }
                        }

                        contentToRender = resolveLatexStyles(contentToRender, html => renderer.protectHtml('style', html));
                        const renderedContent = renderer.renderInline(contentToRender);
                        const itemClass = isSpecialLine ? "alg-item alg-item-no-marker" : "alg-item";
                        listItems += `<li class="${itemClass}">${prefixHtml}${renderedContent}</li>`;
                    });

                    bodyHtml += `<${listTag} class="alg-list">${listItems}</${listTag}>`;
                }

                let ignoredContent = "";
                let lastIdx = 0;
                processedRegions.forEach(reg => {
                    ignoredContent += content.substring(lastIdx, reg.start);
                    lastIdx = reg.end;
                });
                ignoredContent += content.substring(lastIdx);

                const hiddenLabels = recoverPreservedTokens(ignoredContent);
                return `\n\n${renderer.protectHtml('alg', `<div class="latex-algorithm">${captionHtml}${bodyHtml}${hiddenLabels}<div class="alg-bottom-rule"></div></div>`)}\n\n`;
            });
        }
    };
}

/**
 * Converts common table/tabular forms into preview HTML tables.
 */
export function createTableRule(): PreprocessRule {
    return {
        name: 'table',
        priority: 118,
        apply: (text: string, renderer: RenderContext) => {
            return replaceFloatEnvironment(text, 'table', content => {
                const extracted = extractRenderedCaption(content, renderer, { className: 'table-caption', label: 'Table', counterType: 'tbl' });
                content = extracted.content;
                const captionHtml = extracted.captionHtml;

                let innerContent = content.replace(/\\begin\{threeparttable\}/g, '').replace(/\\end\{threeparttable\}/g, '');
                let notesHtml = '';
                const notesMatch = innerContent.match(/\\begin\{tablenotes\}(?:\[.*?\])?([\s\S]*?)\\end\{tablenotes\}/);

                if (notesMatch) {
                    let notesBody = notesMatch[1].replace(/\\(footnotesize|small|scriptsize|tiny)/g, '');
                    innerContent = innerContent.replace(notesMatch[0], '');
                    const noteItems = notesBody.split('\\item').slice(1).map((item: string) => {
                        let itemText = item;
                        let labelHtml = '';
                        const lblMatch = item.match(/^\s*\[(.*?)\]/);
                        if (lblMatch) {
                            labelHtml = `<strong>${renderLatexTableInlineContent(lblMatch[1], renderer)}</strong> `;
                            itemText = item.substring(lblMatch[0].length);
                        }
                        return `<li class="note-item" style="list-style:none">${labelHtml}${renderLatexTableInlineContent(itemText.trim(), renderer)}</li>`;
                    }).join('');
                    notesHtml = `<div class="latex-tablenotes"><ul>${noteItems}</ul></div>`;
                }

                let tableHtml = '';
                let tabularRegion = { start: 0, end: 0 };
                const tabular = findFirstTabularEnvironment(innerContent);

                if (tabular) {
                    tabularRegion = { start: tabular.beginStart, end: tabular.end };
                    const rawContent = innerContent.substring(tabular.bodyStart, tabular.bodyEnd);
                    tableHtml = renderLatexTabular(rawContent, renderer);
                }

                const ignoredContent = innerContent.substring(0, tabularRegion.start) + innerContent.substring(tabularRegion.end);
                const hiddenLabels = recoverPreservedTokens(ignoredContent);

                return `\n\n${renderer.protectHtml('tbl', `<div class="latex-table">${captionHtml}<div class="table-body">${tableHtml}</div>${notesHtml}${hiddenLabels}</div>`)}\n\n`;
            });
        }
    };
}
