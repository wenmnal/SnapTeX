import { PreprocessRule, RenderContext } from './types';
import { escapeHtmlAttribute, extractAndHideLabels, findBalancedClosingBrace, findCommand, resolveLatexStyles } from './utils';
import { recoverPreservedTokens, renderCaptionContent, renderMath, unwrapResizeboxAroundProtectedContent } from './rule-helpers';

/**
 * Converts LaTeX figure environments to protected HTML, preserving captions,
 * labels, local images, PDF canvases, and nested protected TikZ content.
 */
export function createFigureRule(): PreprocessRule {
    return {
        name: 'figure',
        priority: 120,
        apply: (text: string, renderer: RenderContext) => {
            return text.replace(/\\begin\{figure(\*?)\}(?:\[.*?\])?([\s\S]*?)\\end\{figure\1\}/gi, (_match, star, content) => {
                const captionRes = findCommand(content, 'caption');
                let captionHtml = '';
                let body = content;

                if (captionRes) {
                    captionHtml = `<div class="figure-caption"><strong>Figure <span class="sn-cnt" data-type="fig"></span>:</strong> ${renderCaptionContent(captionRes.content, renderer)}</div>`;
                    body = body.substring(0, captionRes.start) + body.substring(captionRes.end + 1);
                }

                const { cleanContent, hiddenHtml } = extractAndHideLabels(body);
                body = cleanContent;

                body = body.trim().replace(/\\centering/g, '');
                body = unwrapResizeboxAroundProtectedContent(body);

                body = body.replace(/\\includegraphics(?:\[.*?\])?\s*\{([^}]+)\}/g, (_imgMatch: string, imgPath: string) => {
                    const cleanPath = imgPath.trim();
                    const safePath = escapeHtmlAttribute(cleanPath);
                    const canvasId = `pdf-${Math.random().toString(36).substr(2, 9)}`;

                    if (cleanPath.toLowerCase().endsWith('.pdf')) {
                        return `<canvas id="${canvasId}" data-req-path="${safePath}" style="width:100%; max-width:100%; display:block; margin:0 auto;"></canvas>`;
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
            return text.replace(/\\begin\{algorithm(\*?)\}(?:\[.*?\])?([\s\S]*?)\\end\{algorithm\1\}/gi, (_match, star, content) => {
                const captionRes = findCommand(content, 'caption');
                let captionHtml = '';
                if (captionRes) {
                    captionHtml = `<div class="alg-caption"><strong>Algorithm <span class="sn-cnt" data-type="alg"></span>:</strong> ${renderCaptionContent(captionRes.content, renderer)}</div>`;
                    content = content.substring(0, captionRes.start) + content.substring(captionRes.end + 1);
                }

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

type TableRuleKind = 'top' | 'mid' | 'bottom' | 'hline';

interface LatexTableRow {
    cells: string[];
    rulesBefore: TableRuleKind[];
}

interface LatexTableModel {
    rows: LatexTableRow[];
    hasBooktabs: boolean;
    hasRules: boolean;
}

interface LatexGroup {
    content: string;
    end: number;
}

const TABLE_ROW_OR_RULE_REGEX = /\\toprule(?:\[.*?\])?|\\midrule(?:\[.*?\])?|\\bottomrule(?:\[.*?\])?|\\cmidrule(?:\[.*?\])?(?:\(.*?\))?\{[^}]+\}|\\hline|\\\\(?:\[.*?\])?/g;

function readLatexGroup(text: string, startIndex: number): LatexGroup | undefined {
    let index = startIndex;
    while (index < text.length && /\s/.test(text[index])) { index++; }
    if (text[index] !== '{') { return undefined; }

    const closeIndex = findBalancedClosingBrace(text, index);
    if (closeIndex === -1) { return undefined; }

    return {
        content: text.substring(index + 1, closeIndex),
        end: closeIndex + 1
    };
}

function classifyTableRule(token: string): TableRuleKind | undefined {
    if (token.startsWith('\\toprule')) { return 'top'; }
    if (token.startsWith('\\midrule') || token.startsWith('\\cmidrule')) { return 'mid'; }
    if (token.startsWith('\\bottomrule')) { return 'bottom'; }
    if (token.startsWith('\\hline')) { return 'hline'; }
    return undefined;
}

function splitLatexTableCells(rowText: string): string[] {
    const cells: string[] = [];
    let cell = '';
    let depth = 0;

    for (let i = 0; i < rowText.length; i++) {
        const char = rowText[i];
        if (char === '\\') {
            cell += char;
            if (i + 1 < rowText.length) {
                cell += rowText[++i];
            }
            continue;
        }
        if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth = Math.max(0, depth - 1);
        }

        if (char === '&' && depth === 0) {
            cells.push(cell.trim());
            cell = '';
        } else {
            cell += char;
        }
    }

    cells.push(cell.trim());
    return cells;
}

function parseLatexTableRows(rawContent: string): LatexTableModel {
    const rows: LatexTableRow[] = [];
    const pendingRules: TableRuleKind[] = [];
    let hasBooktabs = false;
    let hasRules = false;
    let current = '';
    let cursor = 0;

    const pushRow = () => {
        const trimmed = current.trim();
        if (trimmed) {
            rows.push({
                cells: splitLatexTableCells(trimmed),
                rulesBefore: pendingRules.splice(0)
            });
        } else {
            pendingRules.splice(0);
        }
        current = '';
    };

    TABLE_ROW_OR_RULE_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TABLE_ROW_OR_RULE_REGEX.exec(rawContent)) !== null) {
        current += rawContent.substring(cursor, match.index);
        cursor = match.index + match[0].length;

        if (match[0].startsWith('\\\\')) {
            pushRow();
            continue;
        }

        if (current.trim()) {
            pushRow();
        }

        const rule = classifyTableRule(match[0]);
        if (rule) {
            hasRules = true;
            hasBooktabs ||= rule === 'top' || rule === 'mid' || rule === 'bottom';
            pendingRules.push(rule);
        }
    }

    current += rawContent.substring(cursor);
    if (current.trim()) {
        pushRow();
    }

    return { rows, hasBooktabs, hasRules };
}

function cleanLatexTableCell(text: string): string {
    return text
        .replace(/\\(?:centering|raggedright|raggedleft|arraybackslash)\b/g, '')
        .replace(/\\(?:small|footnotesize|scriptsize|tiny|normalsize)\b/g, '')
        .trim();
}

function stripLatexGroupingBraces(text: string): string {
    return text.replace(/\{([^{}]*)\}/g, '$1');
}

function renderLatexTableCell(cellText: string, renderer: RenderContext, tagName: 'td' | 'th'): string {
    let content = cellText.trim();
    const attrs: string[] = [];

    if (content.startsWith('\\multicolumn')) {
        const countGroup = readLatexGroup(content, '\\multicolumn'.length);
        const alignGroup = countGroup ? readLatexGroup(content, countGroup.end) : undefined;
        const contentGroup = alignGroup ? readLatexGroup(content, alignGroup.end) : undefined;
        const colspan = countGroup ? Number.parseInt(countGroup.content, 10) : NaN;

        if (contentGroup) {
            content = contentGroup.content;
            if (Number.isFinite(colspan) && colspan > 1) {
                attrs.push(`colspan="${colspan}"`);
            }
            if (alignGroup) {
                const align = alignGroup.content.includes('r') ? 'right' : alignGroup.content.includes('c') ? 'center' : 'left';
                attrs.push(`class="table-cell-align-${align}"`);
            }
        }
    }

    if (tagName === 'th') {
        attrs.unshift('scope="col"');
    }

    const styledContent = resolveLatexStyles(cleanLatexTableCell(content), html => renderer.protectHtml('style', html));
    const htmlContent = renderer.renderInline(stripLatexGroupingBraces(styledContent));
    const attrText = attrs.length > 0 ? ` ${attrs.join(' ')}` : '';
    return `<${tagName}${attrText}>${htmlContent}</${tagName}>`;
}

function renderLatexTableRows(rows: LatexTableRow[], renderer: RenderContext, tagName: 'td' | 'th', suppressFirstRule: boolean): string {
    return rows.map((row, rowIndex) => {
        const hasRuleAbove = row.rulesBefore.some(rule => rule === 'mid' || rule === 'hline') && !(suppressFirstRule && rowIndex === 0);
        const classAttr = hasRuleAbove ? ' class="table-row-rule-above"' : '';
        const cells = row.cells.map(cell => renderLatexTableCell(cell, renderer, tagName)).join('');
        return `<tr${classAttr}>${cells}</tr>`;
    }).join('');
}

function renderLatexTable(rawContent: string, renderer: RenderContext): string {
    const model = parseLatexTableRows(rawContent);
    if (model.rows.length === 0) { return ''; }

    const firstBodyRowIndex = model.rows.findIndex((row, index) => index > 0 && row.rulesBefore.some(rule => rule === 'mid' || rule === 'hline'));
    const hasHeader = firstBodyRowIndex > 0;
    const headerRows = hasHeader ? model.rows.slice(0, firstBodyRowIndex) : [];
    const bodyRows = hasHeader ? model.rows.slice(firstBodyRowIndex) : model.rows;
    const classNames = ['latex-tabular-preview', model.hasBooktabs ? 'latex-tabular-booktabs' : model.hasRules ? 'latex-tabular-ruled' : ''];

    const theadHtml = hasHeader ? `<thead>${renderLatexTableRows(headerRows, renderer, 'th', true)}</thead>` : '';
    const tbodyHtml = `<tbody>${renderLatexTableRows(bodyRows, renderer, 'td', hasHeader)}</tbody>`;
    return `<table class="${classNames.filter(Boolean).join(' ')}">${theadHtml}${tbodyHtml}</table>`;
}

/**
 * Converts common table/tabular forms into preview HTML tables.
 */
export function createTableRule(): PreprocessRule {
    return {
        name: 'table',
        priority: 140,
        apply: (text: string, renderer: RenderContext) => {
            return text.replace(/\\begin\{table(\*?)\}(?:\[.*?\])?([\s\S]*?)\\end\{table\1\}/gi, (_match, star, content) => {
                const captionRes = findCommand(content, 'caption');
                let captionHtml = '';

                if (captionRes) {
                    captionHtml = `<div class="table-caption"><strong>Table <span class="sn-cnt" data-type="tbl"></span>:</strong> ${renderCaptionContent(captionRes.content, renderer)}</div>`;
                    content = content.substring(0, captionRes.start) + content.substring(captionRes.end + 1);
                }

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
                            labelHtml = `<strong>${renderer.renderInline(lblMatch[1])}</strong> `;
                            itemText = item.substring(lblMatch[0].length);
                        }
                        itemText = itemText.replace(/\$((?:\\.|[^\\$])+?)\$/g, (_m: string, c: string) => renderMath(c.trim(), false, renderer));
                        return `<li class="note-item" style="list-style:none">${labelHtml}${renderer.renderInline(itemText.trim())}</li>`;
                    }).join('');
                    notesHtml = `<div class="latex-tablenotes"><ul>${noteItems}</ul></div>`;
                }

                let tableHtml = '';
                const beginRegex = /\\begin\{(tabular\*?|tabularx)\}/g;
                const beginMatch = beginRegex.exec(innerContent);
                let tabularRegion = { start: 0, end: 0 };

                if (beginMatch) {
                    const envName = beginMatch[1];
                    let contentStartIndex = beginMatch.index + beginMatch[0].length;
                    const requiredArgs = envName === 'tabular' ? 1 : 2;
                    let argsFound = 0;
                    while (argsFound < requiredArgs) {
                        while (contentStartIndex < innerContent.length && /\s/.test(innerContent[contentStartIndex])) { contentStartIndex++; }
                        if (contentStartIndex >= innerContent.length) { break; }
                        if (innerContent[contentStartIndex] === '[') {
                            const closeBracket = innerContent.indexOf(']', contentStartIndex);
                            if (closeBracket !== -1) {
                                contentStartIndex = closeBracket + 1;
                                continue;
                            }
                        }
                        if (innerContent[contentStartIndex] === '{') {
                            const closeBrace = findBalancedClosingBrace(innerContent, contentStartIndex);
                            if (closeBrace !== -1) {
                                contentStartIndex = closeBrace + 1;
                                argsFound++;
                            } else {
                                break;
                            }
                        } else {
                            break;
                        }
                    }

                    const escapedEnvName = envName.replace(/\*/g, '\\*');
                    const endRegex = new RegExp(`\\\\end\\{${escapedEnvName}\\}`, 'g');
                    endRegex.lastIndex = contentStartIndex;
                    const endMatch = endRegex.exec(innerContent);

                    if (endMatch) {
                        tabularRegion = { start: beginMatch.index, end: endMatch.index + endMatch[0].length };
                        let rawContent = innerContent.substring(contentStartIndex, endMatch.index);

                        rawContent = rawContent.replace(/\$((?:\\.|[^\\$])+?)\$/g, (_m: string, c: string) => renderMath(c.trim(), false, renderer));
                        rawContent = rawContent.replace(/\\(?:centering|raggedright|raggedleft|arraybackslash)\b/g, '');
                        rawContent = rawContent.replace(/\\(?:small|footnotesize|scriptsize|tiny|normalsize)\b/g, '');
                        rawContent = rawContent.replace(/\\cline\{[^}]+\}/g, '\\hline');
                        rawContent = rawContent.replace(/\\addlinespace(?:\[.*?\])?/g, '');
                        rawContent = rawContent.replace(/\\vspace\*?\{[^}]+\}/g, '');
                        rawContent = rawContent.replace(/\\setlength\s*\\[a-zA-Z]+\s*\{[^}]+\}/g, '');

                        tableHtml = renderLatexTable(rawContent, renderer);
                    }
                }

                const ignoredContent = innerContent.substring(0, tabularRegion.start) + innerContent.substring(tabularRegion.end);
                const hiddenLabels = recoverPreservedTokens(ignoredContent);

                return `\n\n${renderer.protectHtml('tbl', `<div class="latex-table">${captionHtml}<div class="table-body">${tableHtml}</div>${notesHtml}${hiddenLabels}</div>`)}\n\n`;
            });
        }
    };
}
