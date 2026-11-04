import { CommandsPlugin, UIPlugin, type EmbedPdfContainer, type PluginRegistry, type ToolbarItem } from '@embedpdf/react-pdf-viewer';

const PANEL_ID = 'paper-ai-panel';
const BUTTON_ID = 'paper-ai-button';
const COMMAND_ID = 'paper:toggle-ai-chat';
const WIDTH_KEY = 'paper-timeline:reader-ai-width:v1';

export interface ReaderAiSidebar { close(): void; dispose(): void }

/**
 * EmbedPDF 2.15.1 exposes commands and sidebar schemas, but its snippet wrapper
 * keeps the Preact component registry private. Use those public APIs for the
 * toolbar and exclusive sidebar slot; bridge only our React content into the
 * renderer's data-sidebar-id container. No third-party nodes are replaced.
 * Recheck this small bridge when upgrading EmbedPDF (including its mobile drawer).
 */
export function installReaderAiSidebar(registry: PluginRegistry, container: EmbedPdfContainer,
  documentId: string, onHost: (host: HTMLElement | null) => void): ReaderAiSidebar {
  const ui = registry.getPlugin<UIPlugin>('ui')!.provides();
  const commands = registry.getPlugin<CommandsPlugin>('commands')!.provides();
  const scope = ui.forDocument(documentId);
  // onReady precedes DocumentManager.openDocumentBuffer. UI scopes exist at
  // this point, but their per-document state is created on loading-started.
  // Commands are also resolved during that transition, so gate every scope
  // query on the public store's UI document record instead of catching errors.
  const hasDocumentState = () => {
    const state = registry.getStore().getState().plugins.ui as { documents?: Record<string, unknown> } | undefined;
    return !!state?.documents?.[documentId];
  };
  const root = container.shadowRoot;
  if (!root) throw new Error('无法初始化 AI 侧栏');
  let preferredWidth = 380;
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(stored) && stored >= 280 && stored <= 1000) preferredWidth = stored;
  } catch { /* Resizing still works when browser storage is unavailable. */ }
  const limits = () => {
    const max = Math.max(280, Math.min(1000, Math.floor(container.getBoundingClientRect().width) - 320));
    return { min: Math.min(300, max), max };
  };
  let currentHandle: HTMLElement | null = null;
  let appliedWidth = preferredWidth;
  let drag: { id: number; x: number; width: number; requested: number } | null = null;
  let resizeFrame = 0;
  const applyWidth = (width = preferredWidth) => {
    const { min, max } = limits(); appliedWidth = Math.round(Math.max(min, Math.min(max, width)));
    container.style.setProperty('--paper-ai-sidebar-width', `${appliedWidth}px`);
    currentHandle?.setAttribute('aria-valuemin', String(min)); currentHandle?.setAttribute('aria-valuemax', String(max));
    currentHandle?.setAttribute('aria-valuenow', String(appliedWidth)); currentHandle?.setAttribute('aria-valuetext', `${appliedWidth} 像素`);
  };
  const rememberWidth = () => {
    preferredWidth = appliedWidth;
    try { localStorage.setItem(WIDTH_KEY, String(preferredWidth)); } catch { /* Keep the in-memory preference. */ }
  };
  const finishDrag = (commit: boolean) => {
    cancelAnimationFrame(resizeFrame); resizeFrame = 0;
    const active = drag; drag = null;
    if (active) {
      applyWidth(commit ? active.requested : active.width);
      if (commit) rememberWidth();
      if (currentHandle?.hasPointerCapture(active.id)) currentHandle.releasePointerCapture(active.id);
    }
    container.classList.remove('reader-ai-resizing');
  };
  const detachHandle = () => { finishDrag(false); currentHandle?.remove(); currentHandle = null; };
  const createHandle = () => {
    const handle = window.document.createElement('div');
    handle.className = 'reader-ai-resize-handle'; handle.tabIndex = 0;
    handle.setAttribute('role', 'separator'); handle.setAttribute('aria-label', '调整 AI 对话框宽度'); handle.setAttribute('aria-orientation', 'vertical');
    handle.title = '左右拖动调整宽度；方向键微调';
    handle.addEventListener('pointerdown', event => {
      if (!event.isPrimary || event.button !== 0) return;
      event.preventDefault(); event.stopPropagation();
      drag = { id: event.pointerId, x: event.clientX, width: appliedWidth, requested: appliedWidth };
      handle.setPointerCapture(event.pointerId); container.classList.add('reader-ai-resizing');
    });
    handle.addEventListener('pointermove', event => {
      if (!drag || drag.id !== event.pointerId) return;
      event.preventDefault(); event.stopPropagation(); drag.requested = drag.width + drag.x - event.clientX;
      if (!resizeFrame) resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; if (drag) applyWidth(drag.requested); });
    });
    handle.addEventListener('pointerup', event => { if (drag?.id === event.pointerId) { event.preventDefault(); event.stopPropagation(); finishDrag(true); } });
    handle.addEventListener('pointercancel', () => finishDrag(false));
    handle.addEventListener('lostpointercapture', () => { if (drag) finishDrag(true); });
    handle.addEventListener('keydown', event => {
      const { min, max } = limits();
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'Escape') { if (drag) finishDrag(false); return; }
      applyWidth(event.key === 'Home' ? min : event.key === 'End' ? max : appliedWidth + (event.key === 'ArrowLeft' ? 20 : -20));
      rememberWidth();
    });
    return handle;
  };
  const schema = ui.getSchema();
  const mainToolbar = schema.toolbars['main-toolbar'];
  if (!mainToolbar) throw new Error('无法初始化 AI 阅读工具栏');
  const button: ToolbarItem = { type: 'command-button', id: BUTTON_ID, commandId: COMMAND_ID, variant: 'text' };
  let placed = false;
  const items = mainToolbar.items.map(item => {
    if (item.type !== 'group' || item.id !== 'right-group') return item;
    placed = true;
    return { ...item, items: [...item.items.filter(child => child.id !== BUTTON_ID), button] };
  });
  if (!placed) items.push(button);
  commands.registerCommand({
    id: COMMAND_ID, label: 'AI', description: '打开或收起 AI 聊天',
    action: () => { if (hasDocumentState()) scope.toggleSidebar('right', 'main', PANEL_ID); },
    active: () => hasDocumentState() && scope.isSidebarOpen('right', 'main', PANEL_ID),
    disabled: () => !hasDocumentState(),
  });
  ui.mergeSchema({
    toolbars: { 'main-toolbar': { ...mainToolbar, items } },
    sidebars: {
      [PANEL_ID]: {
        id: PANEL_ID, position: { placement: 'right', slot: 'main', order: 0 },
        // An empty native panel reserves the slot; React owns its content only.
        content: { type: 'tabs', tabs: [] }, width: '380px', collapsible: true, defaultOpen: false,
      },
    },
  });
  const style = window.document.createElement('style');
  style.textContent = `
    [data-sidebar-id="${PANEL_ID}"] { flex-shrink: 0; min-width: 0; width: var(--paper-ai-sidebar-width, 380px) !important; }
    [data-sidebar-id="${PANEL_ID}"] > :last-child { position: relative; min-width: 0; overflow: hidden; }
    [data-sidebar-id="${PANEL_ID}"] > :last-child > :not(.reader-ai-mount):not(.reader-ai-resize-handle) { display: none; }
    .reader-ai-mount { position: absolute; inset: 0; display: flex; min-width: 0; min-height: 0; }
    .reader-ai-resize-handle { position: absolute; z-index: 50; top: 0; bottom: 0; left: 0; width: 7px; cursor: col-resize; touch-action: none; user-select: none; }
    .reader-ai-resize-handle::after { content: ''; position: absolute; inset: 0 auto 0 0; width: 2px; background: transparent; transition: background .12s; }
    .reader-ai-resize-handle:hover::after, .reader-ai-resize-handle:focus-visible::after, :host(.reader-ai-resizing) .reader-ai-resize-handle::after { background: #7395e8; }
    .reader-ai-resize-handle:focus-visible { outline: none; }
    :host(.reader-ai-resizing), :host(.reader-ai-resizing) * { cursor: col-resize !important; user-select: none !important; }
    [data-epdf-i="${BUTTON_ID}"] button { min-width: 30px; font-weight: 600; }
  `;
  root.appendChild(style);
  let currentHost: HTMLElement | null = null;
  let disposed = false;
  let focusFrame = 0;
  function syncHost() {
    if (disposed) return;
    const isOpen = hasDocumentState() && scope.isSidebarOpen('right', 'main', PANEL_ID);
    if (!isOpen) {
      detachHandle();
      if (currentHost) { currentHost.remove(); currentHost = null; onHost(null); }
      return;
    }
    // Chat updates and PDF page rendering also mutate this shadow root. The
    // existing host needs no DOM search unless the native panel was recreated.
    if (currentHost?.isConnected && root!.contains(currentHost)) return;
    const panel = root!.querySelector<HTMLElement>(`[data-sidebar-id="${PANEL_ID}"]`);
    const content = panel?.lastElementChild as HTMLElement | null;
    if (!content) {
      detachHandle();
      if (currentHost) { currentHost.remove(); currentHost = null; onHost(null); }
      return;
    }
    currentHost?.remove();
    detachHandle();
    currentHost = window.document.createElement('div');
    currentHost.className = 'reader-ai-mount';
    content.appendChild(currentHost);
    currentHandle = createHandle(); content.appendChild(currentHandle); applyWidth();
    onHost(currentHost);
    cancelAnimationFrame(focusFrame);
    focusFrame = requestAnimationFrame(() => currentHost?.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true }));
  }
  const observer = new MutationObserver(syncHost);
  observer.observe(root, { childList: true, subtree: true });
  const offSidebar = scope.onSidebarChanged(() => {
    syncHost();
    // Native rendering can happen on the next Preact update after the event.
    queueMicrotask(syncHost);
  });
  const close = () => {
    if (disposed || !hasDocumentState() || !scope.isSidebarOpen('right', 'main', PANEL_ID)) return;
    scope.closeSidebarSlot('right', 'main');
    root.querySelector<HTMLButtonElement>(`[data-epdf-i="${BUTTON_ID}"] button`)?.focus({ preventScroll: true });
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.isComposing || !currentHost || !event.composedPath().includes(currentHost)) return;
    event.preventDefault(); event.stopPropagation(); close();
  };
  root.addEventListener('keydown', escape as EventListener, true);
  const resizeObserver = new ResizeObserver(() => { if (!drag) applyWidth(); });
  resizeObserver.observe(container); applyWidth();
  syncHost();
  return { close, dispose: () => {
    disposed = true;
    observer.disconnect(); resizeObserver.disconnect(); offSidebar(); cancelAnimationFrame(focusFrame); detachHandle();
    root.removeEventListener('keydown', escape as EventListener, true);
    commands.unregisterCommand(COMMAND_ID);
    currentHost?.remove(); currentHost = null; style.remove();
    container.style.removeProperty('--paper-ai-sidebar-width');
  } };
}
