export interface BibEntry {
    key: string;
    type: string;
    fields: Record<string, string>;
}

export interface SourceLocation {
    file: string;
    line: number;
}

export interface PreambleData {
    macros: Record<string, string>;
    tikzGlobal: string;
    tikzMacroMap: Map<string, string>;

    title?: string;
    author?: string;
    date?: string;
}

export interface MetadataResult {
    data: PreambleData;
    cleanedText: string;
}

export interface RenderedBlockMeta {
    index: number;
    hash: string;
    line: number;
    lineCount: number;
    anchors: string[];
}

export interface BlockNumberingCounts {
    eq: string[];
    fig: string[];
    tbl: string[];
    alg: string[];
    sec: string[];
    thm: string[];
}

export interface NumberingPayload {
    blocks: { [index: number]: BlockNumberingCounts };
    labels: Record<string, string>;
}

export interface PatchPayload {
    type: 'full' | 'patch';
    start?: number;
    deleteCount?: number;
    htmls?: string[];
    blocks?: RenderedBlockMeta[];
    shift?: number;
    preserveUnchangedBlocks?: boolean;

    numbering?: NumberingPayload;

    /**
     * Blocks that must be refreshed even though their source hash did not change.
     */
    dirtyBlocks?: { [index: number]: string };
}

export interface RenderContext {
    currentMacros: Record<string, string>;
    currentDocument?: { metadata: PreambleData };
    citedKeys: string[];
    bibEntries: Map<string, BibEntry>;
    protect(namespace: string, content: string): string;
    protectHtml(namespace: string, html: string): string;
    renderInline(text: string): string;
    resolveCitation(key: string): number;
}

export interface PreprocessRule {
    name: string;
    priority: number;
    apply: (text: string, renderer: RenderContext) => string;
}
