import type { MarkdownAPI, NativeDocumentSnapshot } from './native-document';
export interface EventRecord {
  id: number; pos: number; created_at: number; deadline_raw: string;
  deadline_ts: number | null; done: number; top_divider: number;
  content_html: string; content_text: string;
}
export interface AssetRecord { id: number; w: number; h: number; data: Uint8Array }
export type AssetInput=Omit<AssetRecord,'id'>;
export interface DocumentSnapshot {
  handle: string; path: string; name: string; events: EventRecord[]; revision: number;
  readOnly?: boolean; warning?: string; recovered?:boolean; recoveryBackup?:string;
  draft?: boolean;
}
export interface SaveRequest { handle: string; revision: number; events: EventRecord[] }
export interface SaveResult { revision: number; idMap: Record<string, number>; backup?: string; warning?: string }
export interface SearchHit { id: number; text: string }
export interface Settings {
  theme: 'dark' | 'light' | 'green' | 'system'; fontSize: number; lineSpacing: number; sidebar: boolean;
  sidebarWidth: number; lineNumbers: boolean; closeToTray: boolean; advanceMinutes: number;
  autoHideToolbar: boolean;
  wordWrap: boolean;
  newFileDirectory: string;
}
export interface SessionData {
  newFileSequence?:{date:string;next:number};
  autoNamedDocuments?:{path:string;identity:string}[];
  defaultNewFileDirectory?:string;
  settings: Settings; recent: string[];
  tabs: { path: string; scroll: number; cursor: number }[]; active: number;
  bounds?: { width: number; height: number; x?: number; y?: number };
  maximized?:boolean; nextDraft?:number; warning?:string; systemDark?:boolean;
}
export const defaultSettings: Settings = {
  theme: 'dark', fontSize: 15, lineSpacing: 1.5, sidebar: true, sidebarWidth: 248,
  lineNumbers: true, closeToTray: false, advanceMinutes: 5, autoHideToolbar: false, wordWrap: true, newFileDirectory: '',
};
export interface Notice { id:string; key: string; handle: string; eventId: number; text: string; due: number; fileName:string; createdAt:number }
export type ReminderAction='open'|'done'|'snooze'|'dismiss';
export type ReminderEdit=Notice & {deadline?:{raw:string;ts:number}};
export interface ReminderView { notice?:Notice; count:number; theme:'dark'|'light'|'green'; error:string; busy:boolean }
export interface ReminderAPI {
  ready():Promise<void>;
  onState(callback:(state:ReminderView)=>void):()=>void;
  action(id:string,action:ReminderAction,snoozeText?:string):Promise<void>;
  pause(value:boolean):Promise<void>;
}
export interface DesktopAPI {
  restoreSession():Promise<({status:'fulfilled';value:NativeDocumentSnapshot}|{status:'rejected';reason:string})[]>;
  open(): Promise<NativeDocumentSnapshot | null>;
  openRecent(path: string): Promise<NativeDocumentSnapshot>;
  openDroppedFiles(files: File[]): Promise<NativeDocumentSnapshot[]>;
  markdown: MarkdownAPI;
  create(): Promise<DocumentSnapshot>;
  reload(request: SaveRequest): Promise<DocumentSnapshot>;
  revealRecovery(handle: string): Promise<void>;
  save(request: SaveRequest): Promise<SaveResult>;
  saveAs(request: SaveRequest): Promise<DocumentSnapshot | null>;
  close(handle: string, rememberRecent?: boolean): Promise<void>;
  search(handle: string, query: string): Promise<SearchHit[]>;
  assetPreview(handle:string,id:number):Promise<string>;
  asset(handle: string, id: number): Promise<AssetRecord | null>;
  addAsset(handle: string, data: Uint8Array, w: number, h: number): Promise<number>;
  addAssets(handle:string,assets:AssetInput[]):Promise<number[]>;
  imageInfo(data:Uint8Array):Promise<{width:number;height:number}>;
  /** Resolves to the written path, or an empty string when the user cancels. */
  exportFile(handle: string, format: 'md' | 'txt' | 'pdf', html: string, text: string): Promise<string>;
  revealExport(): Promise<void>;
  /** Writes an input event trace for a bug report and resolves to the file's path. */
  saveDiagnostics(text: string): Promise<string>;
  reveal(handle: string): Promise<void>;
  revealRecent(file: string): Promise<void>;
  renameFormat(request:import('./native-document').FormatRenameRequest):Promise<NativeDocumentSnapshot>;
  rename(handle: string,name?:string): Promise<DocumentSnapshot | null>;
  openLink(url: string): Promise<void>;
  copy(data: { text: string; html?: string; externalHtml?: string; events?: string; image?: Uint8Array }): Promise<void>;
  readClipboard(): Promise<{ text: string; html: string; events: string; richText?:boolean; image?: Uint8Array; images?:{name:string;data:Uint8Array}[] }>;
  session(): Promise<SessionData>;
  chooseNewFileDirectory():Promise<string|null>;
  onRecentChanged(callback:(paths:string[])=>void):()=>void;
  ready(): Promise<void>;
  showSearch(): Promise<void>;
  onSearchFocus(callback:(focused:boolean)=>void):()=>void;
  onOpened(callback: (document: NativeDocumentSnapshot) => void): () => void;
  onError(callback: (message: string) => void): () => void;
  onTheme(callback: (dark: boolean) => void): () => void;
  updateSession(data: Partial<SessionData>): Promise<void>;
  minimize(): void; maximize(): void; requestClose(): void; confirmClose(ok: boolean): void;
  onClose(callback: () => void): () => void;
  onWindowInactive(callback: () => void): () => void;
  onCommand(callback: (command: string) => void): () => void;
  onNotices(callback: (notices: Notice[]) => void): () => void;
  showReminders():Promise<void>;
  onReminderEdit(callback:(notice:ReminderEdit)=>void):()=>void;
  reminderEdited(id:string,error?:string):Promise<void>;
  onReveal(callback: (target: { handle: string; eventId: number }) => void): () => void;
  snooze(key: string): Promise<void>;
  snoozedEvents(handle: string): Promise<number[]>;
}
declare global { interface Window { desktop: DesktopAPI; reminder:ReminderAPI } }
