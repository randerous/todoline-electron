import type { DocumentSnapshot, EventRecord, AssetRecord } from './types';

/** File-backed Markdown and plain text never become TDE database events. */
export interface TextFileSnapshot {
  kind: 'markdown' | 'text';
  encoding?: 'utf8' | 'utf16le' | 'utf16be';
  handle: string;
  path: string;
  name: string;
  source: string;
  revision: number;
  draft: boolean;
  readOnly?: boolean;
  recovered?: boolean;
  warning?: string;
  recoveryBackup?: string;
}

export interface MarkdownSnapshot extends TextFileSnapshot { kind: 'markdown' }
export interface PlainTextSnapshot extends TextFileSnapshot { kind: 'text' }
export type NativeDocumentSnapshot = DocumentSnapshot | TextFileSnapshot;
export interface FormatRenameRequest {handle:string;revision:number;name:string;source?:string;events?:EventRecord[];assets?:AssetRecord[];references?:string[]}
export interface MarkdownSaveRequest { handle: string; revision: number; source: string; assets?: string[] }
export interface MarkdownSaveResult { revision: number; warning?: string }
export interface MarkdownHeading { id: string; pos: number; level: number; text: string }

export function isMarkdownDocument(doc: NativeDocumentSnapshot): doc is MarkdownSnapshot {
  return 'kind' in doc && doc.kind === 'markdown';
}
export function isTextDocument(doc: NativeDocumentSnapshot): doc is TextFileSnapshot { return 'kind' in doc && (doc.kind === 'markdown' || doc.kind === 'text'); }
export function isTdePath(file: string): boolean { return /\.tde$/i.test(file); }
export function isMarkdownPath(file: string): boolean { return /\.(md|markdown)$/i.test(file); }
export function isDocumentPath(file: string): boolean { return !!file.trim() && !file.includes('\0') && !/^[a-z][a-z\d+.-]*:\/\//i.test(file); }

export interface MarkdownAPI {
  create(source?: string): Promise<MarkdownSnapshot>;
  save(request: MarkdownSaveRequest): Promise<MarkdownSaveResult>;
  saveAs(request: MarkdownSaveRequest): Promise<TextFileSnapshot | null>;
  reload(request: MarkdownSaveRequest): Promise<TextFileSnapshot>;
  rename(handle: string, name: string): Promise<TextFileSnapshot>;
  addAsset(handle: string, data: Uint8Array, name: string): Promise<string>;
  readAsset(handle: string, reference: string): Promise<string>;
}
