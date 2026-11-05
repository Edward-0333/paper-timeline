import type { CitationMonitorState, CitationPage } from './citation-monitor';
import type { CloudStatus, CloudReview } from './cloud';
import type { ReaderDocument, ReaderState, ReaderUpdate } from './reader';
import type { MarkdownDocument, MarkdownUpdate } from './notes-editor';
import type { MineruEnvironment, MineruState, MineruTier } from './mineru';
import type { ModelConfiguration, ModelConfigurationInput, ModelConnectionResult } from './model-settings';
import type { WebSearchConfiguration, WebSearchConfigurationInput, WebSearchConnectionResult } from './web-search';
import type { ModelChatContext, ModelChatRequest, ModelChatResult, ModelChatProgress, ModelChatHistory } from './model-chat';
import type { LibraryChatRequest, LibraryChatHistory, LibraryChatResult, LibraryChatProgress, LibraryChatApproval, LibraryChatDecision, LibraryConversation, LibraryConversationList } from './library-chat';
import type { CitationOrigin } from './citation-library';
export type PaperStatus = 'queued' | 'extracting' | 'searching' | 'matched' | 'review' | 'error';
export type MetadataSource = 'arXiv' | 'Crossref' | 'PDF' | '手动' | '导入';
export type PaperRating = 1 | 2 | 3 | 4 | 5;
export interface PaperTagPosition {
  side: 'top' | 'right' | 'bottom' | 'left';
  /** Fraction of the available edge length after subtracting the tag's size. */
  offset: number;
}
export interface PaperTag { id: string; text: string; color: string; position?: PaperTagPosition }
export interface MarkdownNote { fileName: string; importedAt: string; sourceHash: string }
export interface ReadingRecord { source: string; fields: { label: string; value: string }[] }
export type PaperFileKind = 'pdf' | 'md';
export interface PaperMetadata {
  title: string;
  authors: string[];
  year: number | null;
  /** Publication date with its original precision: YYYY, YYYY-MM or YYYY-MM-DD. */
  publicationDate?: string;
  venue: string;
  doi: string;
  arxivId: string;
  abstract: string;
  abstractSource?: MetadataSource;
  url: string;
  source: MetadataSource;
  matchMethod: string;
  retrievedAt?: string;
}
export interface Paper extends PaperMetadata {
  id: string;
  /** Stable basename under library/papers; required in storage schema version 2. */
  storageFolder?: string;
  /** Undefined: legacy PDF hash equals id. Null: no PDF attached. */
  pdfHash?: string | null;
  catalogKey?: string;
  /** Stable identities of cached citing works explicitly imported into this library. */
  citationOrigins?: CitationOrigin[];
  fileName: string;
  fileSize: number;
  pageCount: number;
  importedAt: string;
  status: PaperStatus;
  message: string;
  thumbnail?: string;
  folderId?: string | null;
  tags?: PaperTag[];
  /** Personal rating; omitted when unrated. */
  rating?: PaperRating;
  /** Personal concise reading comment, independent of the Markdown attachment. */
  briefNote?: string;
  /** Only new entries are marked unread; omitted for legacy or opened entries. */
  unread?: boolean;
  citationMonitoring?: boolean;
  citationSubscription?: { account: string; revision: number; paperId?: string; retireLegacy?: { id: number; revision: number } };
  /** Runtime status; citation records are stored separately under citations/. */
  citationMonitor?: CitationMonitorState;
  markdownNote?: MarkdownNote;
  readingRecord?: ReadingRecord;
  fileTagPositions?: Partial<Record<PaperFileKind, PaperTagPosition>>;
  /** Runtime file checks; never persisted in library.json. */
  availableFiles?: Record<PaperFileKind, boolean>;
}
export interface ExtractedPdf {
  title: string;
  authors: string[];
  pageCount: number;
  firstPageText: string;
  doi: string;
  arxivId: string;
  abstract: string;
  year: number | null;
  thumbnail?: string;
}
export interface ImportResult { imported: number; duplicates: number; errors: string[]; paperIds?: string[] }
export type CitationInput = Pick<PaperMetadata, 'title'> & Partial<Pick<PaperMetadata, 'authors' | 'publicationDate' | 'venue' | 'doi' | 'arxivId' | 'abstract'>>;
export interface CreatePaperResult { id: string; created: boolean; accepted: boolean }
export interface LibraryFolder { id: string; name: string }
export interface TimelinePosition { x: number; y: number }
export interface TimelineTrack {
  id: string;
  tags: string[];
  tagMode: 'all' | 'any';
  /** A newly added track stays empty until its first tag selection. */
  configured: boolean;
  /** World coordinates of the top-left corner of the tag-filter box. */
  position: TimelinePosition;
}
export type TimelineChanges = Partial<Pick<TimelineTrack, 'tags' | 'tagMode' | 'position'>>;
export interface LibraryState { papers: Paper[]; folders: LibraryFolder[]; timelines: TimelineTrack[]; storagePath: string }
export type StorageAction = 'open' | 'copy' | 'create';
export interface StorageSelection { mode: StorageAction; directory: string; paperCount: number }
export interface PaperApi {
  getWebSearchConfig(): Promise<WebSearchConfiguration>;
  saveWebSearchConfig(input: WebSearchConfigurationInput): Promise<WebSearchConfiguration>;
  clearWebSearchConfig(): Promise<WebSearchConfiguration>;
  testWebSearchConnection(input: WebSearchConfigurationInput): Promise<WebSearchConnectionResult>;
  cancelWebSearchConnectionTest(): Promise<void>;
  getModelConfig(): Promise<ModelConfiguration>;
  testModelConnection(input: ModelConfigurationInput): Promise<ModelConnectionResult>;
  cancelModelConnectionTest(): Promise<void>;
  getModelChatContext(paperId: string): Promise<ModelChatContext>;
  openChatLink(url: string): Promise<void>;
  getModelChatHistory(paperId: string): Promise<ModelChatHistory>;
  clearModelChatHistory(paperId: string): Promise<void>;
  onModelChatProgress(callback: (progress: ModelChatProgress) => void): () => void;
  chatModel(input: ModelChatRequest): Promise<ModelChatResult>;
  cancelModelChat(requestId: string): Promise<void>;
  chatLibrary(input: LibraryChatRequest): Promise<LibraryChatResult>;
  listLibraryConversations(): Promise<LibraryConversationList>;
  createLibraryConversation(): Promise<LibraryConversation>;
  selectLibraryConversation(id: string): Promise<LibraryConversationList>;
  renameLibraryConversation(id: string, title: string): Promise<LibraryConversation>;
  deleteLibraryConversation(id: string): Promise<LibraryConversationList>;
  getLibraryChatHistory(conversationId?: string): Promise<LibraryChatHistory>;
  clearLibraryChatHistory(conversationId?: string): Promise<void>;
  cancelLibraryChat(requestId: string): Promise<void>;
  getLibraryChatApproval(conversationId?: string): Promise<LibraryChatApproval | null>;
  resolveLibraryChatApproval(decision: LibraryChatDecision): Promise<void>;
  onLibraryChatProgress(callback: (progress: LibraryChatProgress) => void): () => void;
  saveModelConfig(input: ModelConfigurationInput, activate?: boolean): Promise<ModelConfiguration>;
  selectModelConfig(id: string): Promise<ModelConfiguration>;
  clearModelConfig(profileId?: string): Promise<ModelConfiguration>;
  mineruEnvironment(): Promise<MineruEnvironment>;
  chooseMineruExecutable(): Promise<MineruEnvironment | null>;
  conversionState(id: string): Promise<MineruState>;
  convertPdf(id: string, tier: MineruTier): Promise<{ accepted: boolean; alreadyProcessing: boolean }>;
  cancelConversion(id: string): Promise<MineruState>;
  openConversion(id: string, kind: 'markdown' | 'json' | 'directory'): Promise<void>;
  readerDocument(id: string): Promise<ReaderDocument>;
  saveReaderState(id: string, update: ReaderUpdate): Promise<ReaderState>;
  getMarkdownDocument(id: string): Promise<MarkdownDocument>;
  saveMarkdownDocument(id: string, update: MarkdownUpdate): Promise<MarkdownDocument>;
  setReaderActive(active: boolean): Promise<void>;
  readerCloseReady(error?: string): Promise<void>;
  onReaderFlush(callback: () => void): () => void;
  cloudStatus(): Promise<CloudStatus>;
  cloudLogin(server: string, username: string, password: string): Promise<CloudStatus>;
  cloudLogout(): Promise<CloudStatus>;
  cloudSync(): Promise<CloudStatus>;
  cloudMigrate(): Promise<void>;
  cloudReview(offset?: number): Promise<CloudReview>;
  cloudReconcile(): Promise<CloudReview>;
  cloudImportLegacy(id: number, revision: number): Promise<{ id: string; created: boolean }>;
  cloudStopLegacy(id: number, revision: number): Promise<void>;
  onCloudChanged(callback: (state: CloudStatus) => void): () => void;
  getLibrary(): Promise<LibraryState>;
  chooseLibraryLocation(mode: StorageAction): Promise<StorageSelection | null>;
  applyLibraryLocation(mode: StorageAction, directory: string): Promise<void>;
  createTimeline(position?: TimelinePosition): Promise<TimelineTrack>;
  updateTimeline(id: string, changes: TimelineChanges): Promise<TimelineTrack>;
  deleteTimeline(id: string): Promise<void>;
  choosePdfs(folderId?: string | null): Promise<ImportResult | null>;
  importFiles(files: File[], folderId?: string | null): Promise<ImportResult>;
  createPaper(fields: CitationInput, folderId?: string | null): Promise<CreatePaperResult>;
  choosePaperPdf(id: string): Promise<boolean>;
  createFolder(name: string): Promise<LibraryFolder>;
  renameFolder(id: string, name: string): Promise<void>;
  deleteFolder(id: string): Promise<void>;
  movePaper(id: string, folderId: string | null): Promise<void>;
  setRating(id: string, rating: PaperRating | null): Promise<void>;
  setBriefNote(id: string, text: string): Promise<void>;
  markOpened(id: string): Promise<void>;
  setCitationMonitoring(id: string, enabled: boolean): Promise<void>;
  getCitations(id: string, offset?: number, limit?: number): Promise<CitationPage>;
  addCitation(seedId: string, citationId: string): Promise<CreatePaperResult>;
  openCitationDirectory(id: string): Promise<void>;
  addTag(id: string, text: string, color: string): Promise<PaperTag>;
  updateTag(id: string, tagId: string, text: string, color: string): Promise<void>;
  moveTag(id: string, tagId: string, position: PaperTagPosition): Promise<void>;
  moveFileTag(id: string, kind: PaperFileKind, position: PaperTagPosition): Promise<void>;
  deleteTag(id: string, tagId: string): Promise<void>;
  retry(id: string): Promise<void>;
  saveMetadata(id: string, metadata: PaperMetadata): Promise<void>;
  openPdf(id: string): Promise<void>;
  openPaperDirectory(id: string): Promise<void>;
  chooseMarkdown(id: string): Promise<MarkdownNote | null>;
  openMarkdown(id: string): Promise<void>;
  openSource(id: string): Promise<void>;
  revealLibrary(): Promise<void>;
  onLibraryChanged(callback: (state: LibraryState) => void): () => void;
}
