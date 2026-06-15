import { MetadataResult } from './types';
import { findCommand, readLatexGroup, skipLatexWhitespace } from './utils';

type MacroDefinitionCommand = 'newcommand' | 'renewcommand' | 'providenewcommand' | 'def' | 'gdef' | 'DeclareMathOperator';

interface MacroDefinitionHeader {
    command: MacroDefinitionCommand;
    name: string;
    star: boolean;
    argCount: number;
    hasDefaultArgument: boolean;
    body: {
        content: string;
        start: number;
    };
}

function readMacroName(text: string, index: number): { name: string; end: number } | undefined {
    index = skipLatexWhitespace(text, index);

    const grouped = readLatexGroup(text, index, { delimiter: 'brace', skipWhitespace: false });
    if (grouped) {
        const name = grouped.content.trim();
        return /^\\[a-zA-Z0-9@]+$/.test(name) ? { name, end: grouped.end } : undefined;
    }

    if (text[index] !== '\\') { return undefined; }
    let end = index + 1;
    while (end < text.length && /[a-zA-Z0-9@]/.test(text[end])) { end++; }
    const name = text.substring(index, end);
    return /^\\[a-zA-Z0-9@]+$/.test(name) ? { name, end } : undefined;
}

function readMacroDefinitionHeader(fullDef: string): MacroDefinitionHeader | undefined {
    const commandMatch = /^\\((?:provide|re)?newcommand|g?def|DeclareMathOperator)(\*)?/.exec(fullDef);
    if (!commandMatch) { return undefined; }

    const command = commandMatch[1] as MacroDefinitionCommand;
    const star = commandMatch[2] === '*';
    const macroName = readMacroName(fullDef, commandMatch[0].length);
    if (!macroName) { return undefined; }

    let index = macroName.end;
    let argCount = 0;
    let hasDefaultArgument = false;

    if (command === 'newcommand' || command === 'renewcommand' || command === 'providenewcommand') {
        const argCountGroup = readLatexGroup(fullDef, index, { delimiter: 'bracket' });
        if (argCountGroup && /^\d+$/.test(argCountGroup.content.trim())) {
            argCount = parseInt(argCountGroup.content.trim(), 10);
            index = argCountGroup.end;

            const defaultArgGroup = readLatexGroup(fullDef, index, { delimiter: 'bracket' });
            if (defaultArgGroup) {
                hasDefaultArgument = true;
                index = defaultArgGroup.end;
            }
        }
    } else if (command === 'def' || command === 'gdef') {
        const bodyIndex = fullDef.indexOf('{', index);
        if (bodyIndex === -1) { return undefined; }
        index = bodyIndex;
    }

    const body = readLatexGroup(fullDef, index, { delimiter: 'brace' });
    if (!body) { return undefined; }

    return {
        command,
        name: macroName.name,
        star,
        argCount,
        hasDefaultArgument,
        body: {
            content: body.content,
            start: body.start
        }
    };
}

/**
 * Converts simple \newcommand definitions to \def syntax accepted by TikZJax.
 */
function transpileToDef(header: MacroDefinitionHeader, fullDef: string): string {
    if (!header.command.endsWith('newcommand') || header.hasDefaultArgument) {return fullDef;}

    let args = "";
    for(let i=1; i<=header.argCount; i++) {args += `#${i}`;}

    return `\\def${header.name}${args}${fullDef.substring(header.body.start)}`;
}

interface TextRange {
    start: number;
    end: number;
}

interface DefinitionRecord extends TextRange {
    fullDef: string;
}

function consumeControlSequence(text: string, index: number): number {
    if (text[index] !== '\\') { return index; }
    let i = index + 1;
    while (i < text.length && /[a-zA-Z@]/.test(text[i])) { i++; }
    return i > index + 1 ? i : index + 2;
}

function findDefinitionEnd(text: string, tokenEndIndex: number): number {
    let i = tokenEndIndex;
    let consumedGroup = false;

    while (i < text.length) {
        const beforeWhitespace = i;
        i = skipLatexWhitespace(text, i);
        const char = text[i];

        if (char === '[') {
            const group = readLatexGroup(text, i, { delimiter: 'bracket', skipWhitespace: false });
            if (!group) { return -1; }
            i = group.end;
            continue;
        }

        if (char === '{') {
            const group = readLatexGroup(text, i, { delimiter: 'brace', skipWhitespace: false });
            if (!group) { return -1; }
            consumedGroup = true;
            i = group.end;
            continue;
        }

        if (!consumedGroup && char === '\\') {
            i = consumeControlSequence(text, i);
            continue;
        }

        if (!consumedGroup) {
            i++;
            continue;
        }

        return beforeWhitespace;
    }

    return consumedGroup ? i : -1;
}

function blankOutRanges(text: string, ranges: TextRange[]): string {
    if (ranges.length === 0) { return text; }

    const sorted = [...ranges].sort((a, b) => a.start - b.start);
    let result = "";
    let cursor = 0;

    for (const range of sorted) {
        const start = Math.max(cursor, range.start);
        const end = Math.max(start, range.end);
        result += text.substring(cursor, start);
        result += text.substring(start, end).replace(/[^\r\n]/g, '');
        cursor = end;
    }

    result += text.substring(cursor);
    return result;
}

function collectDefinitions(text: string): DefinitionRecord[] {
    const records: DefinitionRecord[] = [];
    const defRegex = /\\(provide|re)?(newcommand|def|gdef|DeclareMathOperator|usetikzlibrary|tikzset|definecolor)(\*?)/g;

    let defMatch;
    while ((defMatch = defRegex.exec(text)) !== null) {
        const start = defMatch.index;
        const end = findDefinitionEnd(text, start + defMatch[0].length);
        if (end === -1) { continue; }

        records.push({ start, end, fullDef: text.substring(start, end) });
        defRegex.lastIndex = end;
    }

    return records;
}

function extractKatexMacro(header: MacroDefinitionHeader): { name: string; definition: string } | undefined {
    if (header.command === 'providenewcommand') { return undefined; }

    const rawDefinition = header.body.content.trim();
    const definition = header.command === 'DeclareMathOperator'
        ? (header.star ? `\\operatorname*{${rawDefinition}}` : `\\operatorname{${rawDefinition}}`)
        : rawDefinition;

    return { name: header.name, definition };
}

/**
 * Extracts preamble metadata, macro definitions, and TikZ globals.
 *
 * The returned cleanedText preserves line structure for source mapping while
 * blanking definitions that should not render as document body content.
 */
/**
 * Extract a beamer/standard metadata command, capturing both optional [short] and required {long} args.
 */
function extractMetadataCommand(
    text: string,
    tagName: string,
    maxOptionalArgs: number = 1
): { short: string | undefined; long: string; start: number; end: number } | undefined {
    // Use a more flexible regex for beamer commands that may have [short]{long}
    const regex = new RegExp(
        `\\\\(${tagName})(\\s*\\[[^\\]]*\\])?\\s*\\{`,
        'g'
    );
    regex.lastIndex = 0;
    const match = regex.exec(text);
    if (!match) { return undefined; }
    const start = match.index;
    let idx = start + match[0].length;

    let short: string | undefined;
    // Parse optional args before the required arg
    const optMatch = match[0].match(/\[([^\]]*)\]/);
    if (optMatch) {
        short = optMatch[1].trim();
    }

    // Read the required brace group
    const required = readLatexGroup(text, idx - 1, { delimiter: 'brace' });
    if (!required) { return undefined; }

    return {
        short: short || undefined,
        long: required.content.trim(),
        start,
        end: required.end
    };
}

export function extractMetadata(text: string): MetadataResult {
    let cleanedText = text.replace(/(?<!\\)%.*/gm, '%');

    cleanedText = cleanedText.replace(/\$\$\s*\$\$/g, ' ');

    const todayStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    cleanedText = cleanedText.replace(/\\today\b/g, todayStr);

    let title: string | undefined;
    let subtitle: string | undefined;
    let author: string | undefined;
    let institute: string | undefined;
    let date: string | undefined;
    let affiliation: string | undefined;
    let shortTitle: string | undefined;
    let shortAuthor: string | undefined;
    let shortInstitute: string | undefined;
    let shortDate: string | undefined;

    // Beamer-style \title[Short]{Long}. Keep the long form for display, short for footline.
    const titleRes = extractMetadataCommand(cleanedText, 'title');
    if (titleRes) {
        title = titleRes.long.replace(/\\\\/g, '<br/>');
        shortTitle = titleRes.short;
        cleanedText = cleanedText.substring(0, titleRes.start) + cleanedText.substring(titleRes.end);
    }

    // Beamer-style \subtitle{...}
    const subtitleRes = findCommand(cleanedText, 'subtitle');
    if (subtitleRes) {
        subtitle = subtitleRes.content.trim().replace(/\\\\/g, '<br/>');
        cleanedText = cleanedText.substring(0, subtitleRes.start) + cleanedText.substring(subtitleRes.end);
    }

    // REVTeX/beamer-style \author[...]{...} can appear multiple times.
    // Each author may be followed by an \email{...} on the same line; fold into the author label.
    const authorParts: string[] = [];
    while (true) {
        const next = extractMetadataCommand(cleanedText, 'author');
        if (!next) { break; }
        let entry = next.long.trim();
        let consumeEnd = next.end;
        if (!shortAuthor && next.short) { shortAuthor = next.short; }

        const tail = cleanedText.substring(next.end);
        const emailMatch = tail.match(/^\s*\\email\s*\{([^}]*)\}/);
        if (emailMatch) {
            const emailAddr = emailMatch[1].trim();
            if (emailAddr) {
                entry += ` (${emailAddr})`;
            }
            consumeEnd = next.end + emailMatch[0].length;
        }

        if (entry) { authorParts.push(entry); }
        cleanedText = cleanedText.substring(0, next.start) + cleanedText.substring(consumeEnd);
    }
    if (authorParts.length > 0) {
        author = authorParts.join(', ');
    }

    // Beamer-style \institute[...]{...}
    const instituteRes = extractMetadataCommand(cleanedText, 'institute');
    if (instituteRes) {
        institute = instituteRes.long.replace(/\\\\/g, '<br/>').trim();
        shortInstitute = instituteRes.short;
        cleanedText = cleanedText.substring(0, instituteRes.start) + cleanedText.substring(instituteRes.end);
    }

    // Beamer-style \date[...]{...}
    const dateRes = extractMetadataCommand(cleanedText, 'date');
    if (dateRes) {
        date = dateRes.long.trim();
        shortDate = dateRes.short;
        cleanedText = cleanedText.substring(0, dateRes.start) + cleanedText.substring(dateRes.end);
    }

    // REVTeX-style \affiliation{...}; can also appear multiple times.
    const affParts: string[] = [];
    while (true) {
        const next = findCommand(cleanedText, 'affiliation');
        if (!next) { break; }
        const content = next.content.replace(/\\\\/g, '<br/>').trim();
        if (content) { affParts.push(content); }
        cleanedText = cleanedText.substring(0, next.start) + cleanedText.substring(next.end);
    }
    if (affParts.length > 0) {
        affiliation = affParts.join('<br/>');
    }

    // Strip beamer preamble configuration commands.
    cleanedText = cleanedText.replace(
        /\\(?:use(?:theme|colortheme|fonttheme|outertheme|innertheme)|setbeamertemplate|setbeamercolor|setbeamerfont|setbeamersize|usefonttheme|addtobeamertemplate|DeclareOptionBeamer|ExecuteOptionsBeamer|ProcessOptionsBeamer)(?:\*?)(?:\[[^\]]*\])?(?:\{[^}]*\})*/g,
        ''
    );
    // Strip beamer mode declarations.
    cleanedText = cleanedText.replace(/\\mode\s*<[^>]*>/g, '');

    const tikzGlobalParts: string[] = [];
    const tikzMacroMap = new Map<string, string>();
    const macros: Record<string, string> = {};

    const definitionRecords = collectDefinitions(cleanedText);
    for (const record of definitionRecords) {
        const { fullDef } = record;

        if (/\\(usetikzlibrary|tikzset|definecolor)/.test(fullDef)) {
            if (!tikzGlobalParts.includes(fullDef)) {
                tikzGlobalParts.push(fullDef);
            }
            continue;
        }

        const header = readMacroDefinitionHeader(fullDef);
        if (!header) { continue; }

        const finalDef = transpileToDef(header, fullDef);
        const tikzName = header.command === 'DeclareMathOperator' ? null : header.name;
        if (tikzName && !tikzMacroMap.has(tikzName)) {
            tikzMacroMap.set(tikzName, finalDef);
        }

        const katexMacro = extractKatexMacro(header);
        if (katexMacro) {
            macros[katexMacro.name] = katexMacro.definition;
        }
    }

    const tikzGlobal = tikzGlobalParts.join('\n');
    cleanedText = blankOutRanges(cleanedText, definitionRecords);
    return { data: { macros, tikzGlobal, tikzMacroMap, title, subtitle, author, institute, date, affiliation, shortTitle, shortAuthor, shortInstitute, shortDate }, cleanedText };
}
