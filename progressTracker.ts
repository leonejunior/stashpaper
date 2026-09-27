import { App, MarkdownView, TFile } from "obsidian";

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
  const currentRank = rank[current] ?? 0;
  const candidateRank = rank[candidate] ?? 0;
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
  await app.fileManager.processFrontMatter(file, (fm) => {
    fm["progress"] = newProgress;

    const candidate = progressToStatus(newProgress);
    const current = typeof fm["status"] === "string" ? fm["status"] : "unread";
    if (shouldUpdateStatus(current, candidate)) {
      fm["status"] = candidate;
    }
  });
}

/**
 * Returns true if a TFile is a Stashpaper article (has `source_url` in frontmatter).
 */
export function isStashpaperFile(app: App, file: TFile): boolean {
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
    if (raw > 0 && raw <= 1) return Math.round(raw * 100); // handle 0.0–1.0 fraction
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
 *  - Listening for active-leaf changes to attach/detach scroll listeners
 *  - Debounce-saving scroll position to frontmatter via processFrontMatter
 *  - Restoring scroll position when a Stashpaper note is opened
 *  - Keeping a status-bar element current
 */
export class ReadingProgressTracker {
  private app: App;
  private statusBarEl: HTMLElement;

  // Currently tracked leaf/view state
  private trackedView: MarkdownView | null = null;
  private trackedFile: TFile | null = null;

  // Scroll listener and debounce timer
  private scrollEl: HTMLElement | null = null;
  private scrollHandler: ((e: Event) => void) | null = null;
  private debounceTimer: number | null = null;
  private readonly DEBOUNCE_MS = 2000;

  // Avoid save storms by remembering last saved value
  private lastSavedProgress: number = -1;

  constructor(app: App, statusBarEl: HTMLElement) {
    this.app = app;
    this.statusBarEl = statusBarEl;
    this.hideStatusBar();
  }

  /**
   * Called by the plugin whenever the active leaf changes.
   * Tears down the old listener and sets up a new one if applicable.
   */
  async onActiveLeafChange(leaf: unknown): Promise<void> {
    // Always detach from the previously tracked view first
    this.detachScrollListener();

    if (!leaf) {
      this.hideStatusBar();
      return;
    }

    // We only care about MarkdownView in preview (reading) mode
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      this.hideStatusBar();
      return;
    }

    const file = view.file;
    if (!file || !isStashpaperFile(this.app, file)) {
      this.hideStatusBar();
      return;
    }

    this.trackedView = view;
    this.trackedFile = file;
    this.lastSavedProgress = getSavedProgress(this.app, file);

    // Update status bar immediately with saved value
    this.updateStatusBar(this.lastSavedProgress);

    // Attach scroll listener on the preview container
    // We need to wait briefly for the view to fully mount its DOM
    window.setTimeout(() => {
      this.attachScrollListener(view, file);
      this.restoreScrollPosition(view, file);
    }, 350);
  }

  /**
   * Called when a leaf switches between source/preview mode (layout-change).
   * Re-evaluates the listener setup for the current active view.
   */
  async onLayoutChange(): Promise<void> {
    await this.onActiveLeafChange(null);
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view) {
      await this.onActiveLeafChange(view.leaf);
    }
  }

  /**
   * Attaches a scroll event listener to the preview pane's scrollable element.
   */
  private attachScrollListener(view: MarkdownView, file: TFile): void {
    // The reading-mode scroll container is inside previewMode.containerEl
    const previewContainer = view.previewMode?.containerEl;
    if (!previewContainer) return;

    // Find the actual scrollable element (may be the container or a child)
    const scrollable = this.findScrollableEl(previewContainer);
    if (!scrollable) return;

    this.scrollEl = scrollable;
    this.scrollHandler = () => this.onScroll(view, file);
    scrollable.addEventListener("scroll", this.scrollHandler, { passive: true });
  }

  /**
   * Finds the scrollable child element inside a container.
   * Obsidian preview mode wraps content in `.markdown-preview-view` which scrolls.
   */
  private findScrollableEl(container: HTMLElement): HTMLElement | null {
    // First try the well-known class name used by Obsidian reading mode
    const inner = container.querySelector<HTMLElement>(".markdown-preview-view");
    if (inner) return inner;
    // Fallback: the container itself (if it has overflow-y: auto/scroll)
    return container;
  }

  /**
   * Detaches the current scroll listener and clears any pending debounce save.
   */
  private detachScrollListener(): void {
    if (this.scrollEl && this.scrollHandler) {
      this.scrollEl.removeEventListener("scroll", this.scrollHandler);
    }
    this.scrollEl = null;
    this.scrollHandler = null;

    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.trackedView = null;
    this.trackedFile = null;
  }

  /**
   * Handles a scroll event — debounces the actual save by DEBOUNCE_MS.
   */
  private onScroll(view: MarkdownView, file: TFile): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      this.saveScrollProgress(view, file);
    }, this.DEBOUNCE_MS);
  }

  /**
   * Calculates current scroll percentage from previewMode.getScroll(),
   * then patches frontmatter if it changed meaningfully (±1%).
   *
   * previewMode.getScroll() returns a fraction of total scrollable height.
   * We convert to an integer 0–100 percent.
   */
  private async saveScrollProgress(view: MarkdownView, file: TFile): Promise<void> {
    try {
      const scrollFraction = view.previewMode?.getScroll() ?? 0;
      // getScroll() already returns a value proportional to the max scroll,
      // but its scale can be > 1 in some Obsidian versions (it's a pixel offset
      // divided by the contentHeight). We clamp it.
      const progress = Math.max(0, Math.min(100, Math.round(scrollFraction * 100)));

      // Only write if changed by at least 1%
      if (Math.abs(progress - this.lastSavedProgress) < 1) return;
      this.lastSavedProgress = progress;

      this.updateStatusBar(progress);
      await patchProgressFrontmatter(this.app, file, progress);
    } catch (err) {
      console.debug("Stashpaper: failed to save reading progress", err);
    }
  }

  /**
   * Scrolls the preview pane to the percentage stored in frontmatter
   * after the note finishes rendering.
   */
  private restoreScrollPosition(view: MarkdownView, file: TFile): void {
    const savedProgress = getSavedProgress(this.app, file);
    if (savedProgress <= 0) return;

    // Convert percent back to the fraction expected by applyScroll
    const fraction = savedProgress / 100;

    try {
      view.previewMode?.applyScroll(fraction);
    } catch (err) {
      console.debug("Stashpaper: failed to restore scroll position", err);
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
   * Clean up everything — called when the plugin is unloaded.
   */
  destroy(): void {
    this.detachScrollListener();
    this.hideStatusBar();
  }
}
