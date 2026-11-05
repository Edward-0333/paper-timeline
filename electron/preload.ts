import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { PaperApi, LibraryState } from '../shared/types';
const api: PaperApi = {
  getWebSearchConfig: () => ipcRenderer.invoke('web-search:config'),
  saveWebSearchConfig: input => ipcRenderer.invoke('web-search:save-config', input),
  clearWebSearchConfig: () => ipcRenderer.invoke('web-search:clear-config'),
  testWebSearchConnection: input => ipcRenderer.invoke('web-search:test-connection', input),
  cancelWebSearchConnectionTest: () => ipcRenderer.invoke('web-search:cancel-test'),
  getModelConfig: () => ipcRenderer.invoke('model:config'),
  testModelConnection: input => ipcRenderer.invoke('model:test-connection', input),
  cancelModelConnectionTest: () => ipcRenderer.invoke('model:cancel-test'),
  getModelChatContext: paperId => ipcRenderer.invoke('model:chat-context', paperId),
  openChatLink: url => ipcRenderer.invoke('model:open-link', url),
  getModelChatHistory: paperId => ipcRenderer.invoke('model:chat-history', paperId),
  clearModelChatHistory: paperId => ipcRenderer.invoke('model:clear-chat', paperId),
  onModelChatProgress: callback => {
    const listener = (_event: Electron.IpcRendererEvent, progress: Parameters<typeof callback>[0]) => callback(progress);
    ipcRenderer.on('model:chat-progress', listener);
    return () => ipcRenderer.removeListener('model:chat-progress', listener);
  },
  chatModel: input => ipcRenderer.invoke('model:chat', input),
  cancelModelChat: requestId => ipcRenderer.invoke('model:cancel-chat', requestId),
  chatLibrary: input => ipcRenderer.invoke('library-chat:send', input),
  listLibraryConversations: () => ipcRenderer.invoke('library-chat:list'),
  createLibraryConversation: () => ipcRenderer.invoke('library-chat:create'),
  selectLibraryConversation: id => ipcRenderer.invoke('library-chat:select', id),
  renameLibraryConversation: (id, title) => ipcRenderer.invoke('library-chat:rename', id, title),
  deleteLibraryConversation: id => ipcRenderer.invoke('library-chat:delete', id),
  getLibraryChatHistory: conversationId => ipcRenderer.invoke('library-chat:history', conversationId),
  clearLibraryChatHistory: conversationId => ipcRenderer.invoke('library-chat:clear', conversationId),
  cancelLibraryChat: requestId => ipcRenderer.invoke('library-chat:cancel', requestId),
  getLibraryChatApproval: conversationId => ipcRenderer.invoke('library-chat:approval', conversationId),
  resolveLibraryChatApproval: decision => ipcRenderer.invoke('library-chat:resolve', decision),
  onLibraryChatProgress: callback => {
    const listener = (_event: Electron.IpcRendererEvent, progress: Parameters<typeof callback>[0]) => callback(progress);
    ipcRenderer.on('library-chat:progress', listener);
    return () => ipcRenderer.removeListener('library-chat:progress', listener);
  },
  openPaperDirectory: id => ipcRenderer.invoke('library:open-paper-directory', id),
  saveModelConfig: (input, activate) => ipcRenderer.invoke('model:save-config', input, activate),
  selectModelConfig: id => ipcRenderer.invoke('model:select-config', id),
  clearModelConfig: profileId => ipcRenderer.invoke('model:clear-config', profileId),
  mineruEnvironment: () => ipcRenderer.invoke('mineru:environment'),
  chooseMineruExecutable: () => ipcRenderer.invoke('mineru:choose'),
  conversionState: id => ipcRenderer.invoke('mineru:state', id),
  convertPdf: (id, tier) => ipcRenderer.invoke('mineru:convert', id, tier),
  cancelConversion: id => ipcRenderer.invoke('mineru:cancel', id),
  openConversion: (id, kind) => ipcRenderer.invoke('mineru:open', id, kind),
  readerDocument: id => ipcRenderer.invoke('reader:document', id),
  saveReaderState: (id, update) => ipcRenderer.invoke('reader:save', id, update),
  getMarkdownDocument: id => ipcRenderer.invoke('notes:document', id),
  saveMarkdownDocument: (id, update) => ipcRenderer.invoke('notes:save', id, update),
  setReaderActive: active => ipcRenderer.invoke('reader:active', active),
  readerCloseReady: error => ipcRenderer.invoke('reader:close-ready', error),
  onReaderFlush: callback => {
    const listener = () => callback(); ipcRenderer.on('reader:flush-before-close', listener);
    return () => ipcRenderer.removeListener('reader:flush-before-close', listener);
  },
  cloudStatus: () => ipcRenderer.invoke('cloud:status'),
  cloudLogin: (server, username, password) => ipcRenderer.invoke('cloud:login', server, username, password),
  cloudLogout: () => ipcRenderer.invoke('cloud:logout'),
  cloudSync: () => ipcRenderer.invoke('cloud:sync'),
  cloudMigrate: () => ipcRenderer.invoke('cloud:migrate'),
  cloudReview: offset => ipcRenderer.invoke('cloud:review', offset),
  cloudReconcile: () => ipcRenderer.invoke('cloud:reconcile'),
  cloudImportLegacy: (id, revision) => ipcRenderer.invoke('cloud:import-legacy', id, revision),
  cloudStopLegacy: (id, revision) => ipcRenderer.invoke('cloud:stop-legacy', id, revision),
  onCloudChanged: callback => {
    const listener = (_event: Electron.IpcRendererEvent, state: Parameters<typeof callback>[0]) => callback(state);
    ipcRenderer.on('cloud:changed', listener);
    return () => ipcRenderer.removeListener('cloud:changed', listener);
  },
  getLibrary: () => ipcRenderer.invoke('library:get'),
  createPaper: (fields, folderId) => ipcRenderer.invoke('library:create-paper', fields, folderId),
  choosePaperPdf: id => ipcRenderer.invoke('library:choose-paper-pdf', id),
  chooseLibraryLocation: mode => ipcRenderer.invoke('storage:choose', mode),
  applyLibraryLocation: (mode, directory) => ipcRenderer.invoke('storage:apply', mode, directory),
  createTimeline: position => ipcRenderer.invoke('library:create-timeline', position),
  updateTimeline: (id, changes) => ipcRenderer.invoke('library:update-timeline', id, changes),
  deleteTimeline: id => ipcRenderer.invoke('library:delete-timeline', id),
  choosePdfs: folderId => ipcRenderer.invoke('library:choose', folderId),
  importFiles: (files, folderId) => ipcRenderer.invoke('library:import', files.map(file => webUtils.getPathForFile(file)), folderId),
  createFolder: name => ipcRenderer.invoke('library:create-folder', name),
  renameFolder: (id, name) => ipcRenderer.invoke('library:rename-folder', id, name),
  deleteFolder: id => ipcRenderer.invoke('library:delete-folder', id),
  movePaper: (id, folderId) => ipcRenderer.invoke('library:move-paper', id, folderId),
  setRating: (id, rating) => ipcRenderer.invoke('library:set-rating', id, rating),
  setBriefNote: (id, text) => ipcRenderer.invoke('library:set-brief-note', id, text),
  markOpened: id => ipcRenderer.invoke('library:mark-opened', id),
  setCitationMonitoring: (id, enabled) => ipcRenderer.invoke('library:set-citation-monitoring', id, enabled),
  getCitations: (id, offset, limit) => ipcRenderer.invoke('library:get-citations', id, offset, limit),
  addCitation: (seedId, citationId) => ipcRenderer.invoke('library:add-citation', seedId, citationId),
  openCitationDirectory: id => ipcRenderer.invoke('library:open-citation-directory', id),
  addTag: (id, text, color) => ipcRenderer.invoke('library:add-tag', id, text, color),
  updateTag: (id, tagId, text, color) => ipcRenderer.invoke('library:update-tag', id, tagId, text, color),
  moveTag: (id, tagId, position) => ipcRenderer.invoke('library:move-tag', id, tagId, position),
  moveFileTag: (id, kind, position) => ipcRenderer.invoke('library:move-file-tag', id, kind, position),
  deleteTag: (id, tagId) => ipcRenderer.invoke('library:delete-tag', id, tagId),
  retry: id => ipcRenderer.invoke('library:retry', id),
  saveMetadata: (id, metadata) => ipcRenderer.invoke('library:save', id, metadata),
  openPdf: id => ipcRenderer.invoke('library:open-pdf', id),
  chooseMarkdown: id => ipcRenderer.invoke('library:choose-markdown', id),
  openMarkdown: id => ipcRenderer.invoke('library:open-markdown', id),
  openSource: id => ipcRenderer.invoke('library:open-source', id),
  revealLibrary: () => ipcRenderer.invoke('library:reveal'),
  onLibraryChanged: callback => {
    const listener = (_event: Electron.IpcRendererEvent, state: LibraryState) => callback(state);
    ipcRenderer.on('library:changed', listener);
    return () => ipcRenderer.removeListener('library:changed', listener);
  },
};
contextBridge.exposeInMainWorld('paperApi', api);
