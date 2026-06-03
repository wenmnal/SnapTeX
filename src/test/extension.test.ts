/// <reference types="mocha" />

import * as assert from 'assert';
import * as vscode from 'vscode';
import { BibTexParser } from '../bib';
import { LatexDocument } from '../document';
import { DiffEngine } from '../diff';
import { IFileProvider } from '../file-provider';
import { LatexCounterScanner } from '../scanner';
import { LatexBlockSplitter } from '../splitter';
import { SmartRenderer } from '../renderer';
import { normalizeUri, resolveLatexStyles } from '../utils';

class MemoryFileProvider implements IFileProvider {
    constructor(private readonly files: Map<string, string> = new Map()) {}

    async read(uri: vscode.Uri): Promise<string> {
        const content = this.files.get(normalizeUri(uri));
        if (content === undefined) {
            throw new Error(`Missing test file: ${uri.toString()}`);
        }
        return content;
    }

    async readBuffer(uri: vscode.Uri): Promise<Uint8Array> {
        return new TextEncoder().encode(await this.read(uri));
    }

    async exists(uri: vscode.Uri): Promise<boolean> {
        return this.files.has(normalizeUri(uri));
    }

    async stat(uri: vscode.Uri): Promise<{ mtime: number }> {
        return { mtime: this.files.has(normalizeUri(uri)) ? 1 : 0 };
    }

    resolve(base: vscode.Uri, relative: string): vscode.Uri {
        return vscode.Uri.joinPath(base, relative);
    }

    dir(uri: vscode.Uri): vscode.Uri {
        return vscode.Uri.joinPath(uri, '..');
    }
}

function createDocument(blockTexts: string[]): LatexDocument {
    const doc = new LatexDocument(new MemoryFileProvider());
    doc.blockTexts = blockTexts;
    doc.blockLines = blockTexts.map((_, index) => index * 3);
    doc.blockLineCounts = blockTexts.map(text => text.split(/\r?\n/).length);
    doc.metadata = {
        macros: {},
        tikzGlobal: '',
        tikzMacroMap: new Map()
    };
    doc.bibEntries = new Map();
    doc.contentStartLineOffset = 0;
    return doc;
}

function renderBlocks(blockTexts: string[]): string {
    const provider = new MemoryFileProvider();
    const renderer = new SmartRenderer(provider);
    const payload = renderer.render(createDocument(blockTexts));
    assert.equal(payload.type, 'full');
    assert.ok(payload.htmls);
    return payload.htmls.join('');
}

suite('DiffEngine', () => {
    test('computes unchanged, insert, delete, and replace spans', () => {
        assert.deepStrictEqual(DiffEngine.compute(['a', 'b'], ['a', 'b']), {
            start: 2,
            deleteCount: 0,
            end: 0,
            insertCount: 0
        });

        assert.deepStrictEqual(DiffEngine.compute(['a', 'c'], ['a', 'b', 'c']), {
            start: 1,
            deleteCount: 0,
            end: 1,
            insertCount: 1
        });

        assert.deepStrictEqual(DiffEngine.compute(['a', 'b', 'c'], ['a', 'c']), {
            start: 1,
            deleteCount: 1,
            end: 1,
            insertCount: 0
        });

        assert.deepStrictEqual(DiffEngine.compute(['a', 'old', 'c'], ['a', 'new', 'c']), {
            start: 1,
            deleteCount: 1,
            end: 1,
            insertCount: 1
        });
    });
});

suite('LatexBlockSplitter', () => {
    test('keeps tikzpicture with internal blank lines as one block', () => {
        const text = [
            '\\begin{tikzpicture}',
            '\\draw (0,0) -- (1,1);',
            '',
            '\\node {A};',
            '\\end{tikzpicture}'
        ].join('\n');

        const blocks = LatexBlockSplitter.split(text);

        assert.equal(blocks.length, 1);
        assert.match(blocks[0].text, /\\begin\{tikzpicture\}/);
        assert.match(blocks[0].text, /\\node \{A\};/);
        assert.match(blocks[0].text, /\\end\{tikzpicture\}/);
    });
});

suite('LatexCounterScanner', () => {
    test('numbers regular and starred floats consistently', () => {
        const blocks = [
            '\\begin{figure}\\caption{A}\\label{fig:a}\\end{figure}',
            '\\begin{figure*}\\caption{B}\\label{fig:b}\\end{figure*}',
            '\\begin{table*}\\caption{T}\\label{tbl:t}\\end{table*}',
            '\\begin{algorithm*}\\caption{Alg}\\label{alg:a}\\end{algorithm*}'
        ];

        const result = new LatexCounterScanner().scan(blocks);

        assert.deepStrictEqual(result.blockNumbering[0].counts.fig, ['1']);
        assert.deepStrictEqual(result.blockNumbering[1].counts.fig, ['2']);
        assert.deepStrictEqual(result.blockNumbering[2].counts.tbl, ['1']);
        assert.deepStrictEqual(result.blockNumbering[3].counts.alg, ['1']);
        assert.equal(result.labelMap['fig:a'], '1');
        assert.equal(result.labelMap['fig:b'], '2');
        assert.equal(result.labelMap['tbl:t'], '1');
        assert.equal(result.labelMap['alg:a'], '1');
    });
});

suite('BibTexParser', () => {
    test('parses simple entries with nested brace fields', () => {
        const entries = BibTexParser.parse(`
            @article{smith2024,
              author = {Smith, Jane and Doe, John},
              title = {A {Nested} Title},
              journal = "Journal of Tests",
              year = {2024}
            }
        `);

        const entry = entries.get('smith2024');
        assert.ok(entry);
        assert.equal(entry.type, 'article');
        assert.equal(entry.fields.author, 'Smith, Jane and Doe, John');
        assert.equal(entry.fields.title, 'A {Nested} Title');
        assert.equal(entry.fields.journal, 'Journal of Tests');
        assert.equal(entry.fields.year, '2024');
    });
});

suite('LaTeX style utilities', () => {
    test('renders common text styles including texttt', () => {
        const html = resolveLatexStyles('\\textbf{B} \\textit{I} \\texttt{T} \\underline{U}');

        assert.match(html, /<strong>B<\/strong>/);
        assert.match(html, /<em>I<\/em>/);
        assert.match(html, /<code>T<\/code>/);
        assert.match(html, /<u>U<\/u>/);
    });
});

suite('LatexDocument source mapping', () => {
    test('maps flattened lines back to included source files', async () => {
        const mainUri = vscode.Uri.file('/project/main.tex');
        const sectionUri = vscode.Uri.file('/project/section1.tex');
        const provider = new MemoryFileProvider(new Map([
            [normalizeUri(mainUri), [
                '\\documentclass{article}',
                '\\begin{document}',
                'Root line',
                '\\input{section1}',
                '\\end{document}'
            ].join('\n')],
            [normalizeUri(sectionUri), [
                'Included line',
                '',
                'Second included block'
            ].join('\n')]
        ]));
        const doc = new LatexDocument(provider);

        const result = await doc.parse(mainUri);
        doc.applyResult(result);

        const flatLine = doc.getFlattenedLine(sectionUri.toString(), 0);
        assert.notEqual(flatLine, -1);
        const original = doc.getOriginalPosition(flatLine);
        assert.ok(original);
        assert.equal(normalizeUri(original.file), normalizeUri(sectionUri));
        assert.equal(original.line, 0);
    });
});

suite('SmartRenderer', () => {
    test('does not emit nested latex-block classes for float internals', () => {
        const html = renderBlocks([
            [
                '\\begin{figure}',
                '\\caption{A figure}',
                '\\includegraphics{plot.png}',
                '\\label{fig:a}',
                '\\end{figure}'
            ].join('\n'),
            [
                '\\begin{table}',
                '\\caption{A table}',
                '\\begin{tabular}{c}',
                'A \\\\',
                '\\end{tabular}',
                '\\label{tbl:a}',
                '\\end{table}'
            ].join('\n'),
            [
                '\\begin{algorithm}',
                '\\caption{A procedure}',
                '\\begin{algorithmic}',
                '\\State x',
                '\\end{algorithmic}',
                '\\label{alg:a}',
                '\\end{algorithm}'
            ].join('\n')
        ]);

        const latexBlockClassCount = html.match(/class="latex-block/g)?.length ?? 0;
        assert.equal(latexBlockClassCount, 3);
        assert.doesNotMatch(html, /class="latex-block figure/);
        assert.doesNotMatch(html, /class="latex-block table/);
        assert.doesNotMatch(html, /class="latex-block algorithm/);
    });

    test('keeps registered preprocess rules sorted by priority', () => {
        const provider = new MemoryFileProvider();
        const renderer = new SmartRenderer(provider);
        renderer.registerPreprocessRule({
            name: 'test-order-second',
            priority: -1000,
            apply: text => `${text}B`
        });
        renderer.registerPreprocessRule({
            name: 'test-order-first',
            priority: -2000,
            apply: text => `${text}A`
        });

        const payload = renderer.render(createDocument(['x']));

        assert.equal(payload.type, 'full');
        assert.ok(payload.htmls?.[0].includes('xAB'));
        assert.ok(!payload.htmls?.[0].includes('xBA'));
    });
});
