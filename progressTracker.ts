import { App, MarkdownView, TFile, WorkspaceLeaf } from "obsidian";

/**
 * Maps a progress percentage (0–100) to the Stashpaper status string.
 * 0        → "unread"
 * 1 – 95   → "reading"
 * 96 – 100 → "done"
 */
export function progressToStatus(progress: number): string {
  if (progress <= 0) return "unread";
  if (progress >= 96) return "done";
  return "reading";
}

/**
 * Returns true when `progress` warrants updating the persisted status to `candidate`.
 * We never regress a status backwards (e.g. "done" won't go back to "reading").
 */
function shouldUpdateStatus(current: string, candidate: string): boolean {
  const rank: Record<string, number> = { unread: 0, reading: 1, done: 2 };
  const currentRank = rank[current.toLowerCase()] ?? 0;
  const candidateRank = rank[candidate.toLowerCase()] ?? 0;
  return candidateRank > currentRank;
}

/**
 * Patches `progress` (and optionally `status`) in a Stashpaper note's frontmatter
 * using Obsidian's `fileManager.processFrontMatter` — which surgically updates only
 * the YAML header without touching any other content.
 */
export async function patchProgressFrontmatter(
  app: App,
  file: TFile,
  newProgress: number
): Promise<void> {
  let finalStatus = progressToStatus(newProgress);
  await app.fileManager.processFrontMatter(file, (fm) => {
    fm["progress"] = newProgress;

    const candidate = progressToStatus(newProgress);
    const current = typeof fm["status"] === "string" ? fm["status"] : "unread";
    if (shouldUpdateStatus(current, candidate)) {
      fm["status"] = candidate;
      finalStatus = candidate;
    } else {
      finalStatus = current;
    }
  });

  // Notify any active views (such as Explorer) for instant live UI update
  app.workspace.trigger("stashpaper:progress-updated", file.path, newProgress, finalStatus);
}

/**
 * Returns true if a TFile is a Stashpaper article (has `source_url` in frontmatter).
 */
export function isStashpaperFile(app: App, file: TFile | null | undefined): boolean {
  if (!file || file.extension !== "md") return false;
  const cache = app.metadataCache.getFileCache(file);
  const fm = cache?.frontmatter;
  if (!fm) return false;
  return typeof fm["source_url"] === "string" && fm["source_url"].trim().length > 0;
}

/**
 * Returns the saved progress value (0–100) from the file's frontmatter.
 * Falls back to 0 if absent or invalid.
 */
export function getSavedProgress(app: App, file: TFile): number {
  const cache = app.metadataCache.getFileCache(file);
  const fm = cache?.frontmatter;
  if (!fm) return 0;
  const raw = fm["progress"];
  if (typeof raw === "number") {
    if (raw > 0 && raw <= 1) return Math.round(raw * 100);
    return Math.max(0, Math.min(100, Math.round(raw)));
  }
  if (typeof raw === "string") {
    const parsed = parseFloat(raw.replace("%", "").trim());
    if (!isNaN(parsed)) return Math.max(0, Math.min(100, Math.round(parsed)));
  }
  return 0;
}

/**
 * Manages reading-progress tracking for Stashpaper articles.
 *
 * Responsibilities:
 *  - Listening for active-leaf & layout changes to attach/detach scroll listeners
 *  - Seamlessly tracking scroll in Reading View AND Live Preview
 *  - Debounce-saving scroll position to frontmatter via processFrontMatter
 *  - Restoring scroll position when a Stashpaper note is opened
 *  - Keeping the status-bar element current ("Stashpaper: N% read")
 */
export class ReadingProgressTracker {
  private app: App;
  private statusBarEl: HTMLElement;

  // Currently tracked leaf/view state
  private trackedView: MarkdownView | null = null;
  private trackedFile: TFile | null = null;

  // Attached DOM elements and scroll handler
  private attachedElements: HTMLElement[] = [];
  private scrollHandler: (() => void) | null = null;
  private debounceTimer: number | null = null;
  private isTransitioning: boolean = false;
  private lastSaveTime: number = 0;
  private readonly THROTTLE_MS = 500;
  private readonly DEBOUNCE_MS = 350;

  // Avoid unnecessary disk writes by remembering last saved progress
  private lastSavedProgress: number = -1;

  constructor(app: App, statusBarEl: HTMLElement) {
    this.app = app;
    this.statusBarEl = statusBarEl;
    this.hideStatusBar();
  }

  /**
   * Finds the currently active Stashpaper view and file, even if focus is temporarily
   * in the sidebar (such as the Explorer view).
   */
  private getActiveStashpaperContext(): { view: MarkdownView; file: TFile } | null {
    // 1. Direct active view of type MarkdownView
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView?.file && isStashpaperFile(this.app, activeView.file)) {
      return { view: activeView, file: activeView.file };
    }

    // 2. Active file in workspace
    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile && isStashpaperFile(this.app, activeFile)) {
      const leaves = this.app.workspace.getLeavesOfType("markdown");
      for (const l of leaves) {
        if (l.view instanceof MarkdownView && l.view.file?.path === activeFile.path) {
          return { view: l.view, file: activeFile };
        }
      }
    }

    return null;
  }

  /**
   * Evaluates the active note and attaches tracking if it is a Stashpaper article.
   */
  async checkActiveNote(): Promise<void> {
    const ctx = this.getActiveStashpaperContext();

    if (!ctx) {
      this.detachScrollListener();
      this.hideStatusBar();
      return;
    }

    const { view, file } = ctx;

    // If already tracking this exact view and file, just update the status bar
    if (this.trackedView === view && this.trackedFile?.path === file.path) {
      const current = this.lastSavedProgress >= 0 ? this.lastSavedProgress : getSavedProgress(this.app, file);
      this.updateStatusBar(current);
      return;
    }

    // Flush any pending save for previous note before switching
    this.detachScrollListener();

    this.isTransitioning = true;
    this.trackedView = view;
    this.trackedFile = file;
    this.lastSavedProgress = getSavedProgress(this.app, file);
    this.lastSaveTime = Date.now();

    // Update status bar immediately with the new note's saved progress
    this.updateStatusBar(this.lastSavedProgress);

    // Attach listeners and restore scroll after DOM layout completes
    window.setTimeout(() => {
      if (this.trackedView === view) {
        this.attachScrollListener(view, file);
        this.restoreScrollPosition(view, file);
      }
    }, 200);

    // End transition period after scroll restore has settled
    window.setTimeout(() => {
      if (this.trackedView === view) {
        this.restoreScrollPosition(view, file);
        this.isTransitioning = false;
      }
    }, 450);
  }

  /**
   * Called on active-leaf-change.
   */
  async onActiveLeafChange(leaf?: WorkspaceLeaf | null): Promise<void> {
    await this.checkActiveNote();
  }

  /**
   * Called on layout-change (e.g. view mode toggles source ↔ reading).
   */
  async onLayoutChange(): Promise<void> {
    await this.checkActiveNote();
  }

  /**
   * Attaches scroll listeners to the preview container, CodeMirror scroller,
   * and view content element (using capture) so no scroll event is missed.
   */
  private attachScrollListener(view: MarkdownView, file: TFile): void {
    this.detachScrollListener();

    this.trackedView = view;
    this.trackedFile = file;

    this.scrollHandler = () => this.onScroll(view, file);

    const addTarget = (el: HTMLElement | null | undefined, capture = false) => {
      if (!el || this.attachedElements.includes(el)) return;
      el.addEventListener("scroll", this.scrollHandler!, { passive: true, capture });
      this.attachedElements.push(el);
    };

    // 1. Capture on view container catches ANY descendant scroll (Reading View or Live Preview)
    addTarget(view.contentEl, true);

    // 2. Reading mode container & preview view
    addTarget(view.previewMode?.containerEl);
    const previewInner = view.previewMode?.containerEl?.querySelector<HTMLElement>(".markdown-preview-view");
    if (previewInner) addTarget(previewInner);

    // 3. Live Preview / source editor scroller
    const cmScroller = view.contentEl.querySelector<HTMLElement>(".cm-scroller");
    if (cmScroller) addTarget(cmScroller);
  }

  /**
   * Detaches all scroll listeners and immediately flushes any pending save.
   */
  private detachScrollListener(): void {
    if (this.scrollHandler) {
      for (const el of this.attachedElements) {
        el.removeEventListener("scroll", this.scrollHandler, true);
        el.removeEventListener("scroll", this.scrollHandler, false);
      }
    }
    this.attachedElements = [];
    this.scrollHandler = null;

    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
      // Immediately flush pending save on detach so progress is never lost
      if (this.trackedView && this.trackedFile && !this.isTransitioning) {
        this.saveScrollProgress(this.trackedView, this.trackedFile);
      }
    }

    this.trackedView = null;
    this.trackedFile = null;
    this.isTransitioning = false;
  }

  /**
   * Handles a scroll event — updates live status bar, throttles live saves,
   * and triggers instant transition to reading on first scroll.
   */
  private onScroll(view: MarkdownView, file: TFile): void {
    if (this.isTransitioning) return;

    // Update live status bar immediately as user scrolls
    const liveProgress = this.calculateProgress(view);
    this.updateStatusBar(liveProgress);

    const now = Date.now();

    // 1. If starting to scroll for the first time from 0%, save immediately!
    const isFirstScroll = this.lastSavedProgress <= 0 && liveProgress >= 1;
    if (isFirstScroll) {
      this.lastSaveTime = now;
      this.saveScrollProgress(view, file);
      return;
    }

    // 2. Throttle save every THROTTLE_MS (500ms) while actively reading/scrolling
    if (now - this.lastSaveTime >= this.THROTTLE_MS) {
      this.lastSaveTime = now;
      this.saveScrollProgress(view, file);
    }

    // 3. Trailing debounce of DEBOUNCE_MS (350ms) to capture the resting position
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      this.saveScrollProgress(view, file);
    }, this.DEBOUNCE_MS);
  }

  /**
   * Accurately calculates scroll percentage (0–100) from the visible scroll container.
   */
  private calculateProgress(view: MarkdownView): number {
    const mode = view.getMode();
    let scrollable: HTMLElement | null = null;

    if (mode === "preview") {
      const container = view.previewMode?.containerEl;
      if (container) {
        scrollable = container.classList.contains("markdown-preview-view")
          ? container
          : container.querySelector<HTMLElement>(".markdown-preview-view") || container;
      }
    } else {
      scrollable = view.contentEl.querySelector<HTMLElement>(".cm-scroller") || view.contentEl;
    }

    if (!scrollable) return 0;

    const maxScroll = scrollable.scrollHeight - scrollable.clientHeight;
    if (maxScroll <= 0) return 0;

    const pct = (scrollable.scrollTop / maxScroll) * 100;
    return Math.max(0, Math.min(100, Math.round(pct)));
  }

  /**
   * Saves current scroll progress to note frontmatter via processFrontMatter.
   */
  private async saveScrollProgress(view: MarkdownView, file: TFile): Promise<void> {
    try {
      const progress = this.calculateProgress(view);

      // Only save if progress changed by at least 1%
      if (Math.abs(progress - this.lastSavedProgress) < 1 && this.lastSavedProgress >= 0) return;
      this.lastSavedProgress = progress;

      this.updateStatusBar(progress);
      await patchProgressFrontmatter(this.app, file, progress);
    } catch (err) {
      console.debug("Stashpaper: failed to save reading progress", err);
    }
  }

  /**
   * Restores the scroll position to the percentage stored in frontmatter.
   */
  private restoreScrollPosition(view: MarkdownView, file: TFile): void {
    const savedProgress = getSavedProgress(this.app, file);
    if (savedProgress <= 0) return;

    const mode = view.getMode();
    let scrollable: HTMLElement | null = null;

    if (mode === "preview") {
      const container = view.previewMode?.containerEl;
      if (container) {
        scrollable = container.classList.contains("markdown-preview-view")
          ? container
          : container.querySelector<HTMLElement>(".markdown-preview-view") || container;
      }
    } else {
      scrollable = view.contentEl.querySelector<HTMLElement>(".cm-scroller") || view.contentEl;
    }

    if (scrollable) {
      const maxScroll = scrollable.scrollHeight - scrollable.clientHeight;
      if (maxScroll > 0) {
        const target = (maxScroll * savedProgress) / 100;
        scrollable.scrollTop = target;
      }
    }

    if (mode === "preview" && view.previewMode) {
      try {
        view.previewMode.applyScroll(savedProgress / 100);
      } catch {
        // Handled by direct scrollTop above
      }
    }
  }

  /**
   * Updates the status bar element text.
   */
  private updateStatusBar(progress: number): void {
    this.statusBarEl.style.display = "";
    this.statusBarEl.setText(`Stashpaper: ${progress}% read`);
  }

  /**
   * Hides the status bar element.
   */
  private hideStatusBar(): void {
    this.statusBarEl.style.display = "none";
    this.statusBarEl.setText("");
  }

  /**
   * Clean up everything — called when the plugin unloads.
   */
  destroy(): void {
    this.detachScrollListener();
    this.hideStatusBar();
  }
}
