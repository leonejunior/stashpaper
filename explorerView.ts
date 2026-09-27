import {
  ItemView,
  WorkspaceLeaf,
  TFile,
  setIcon,
  ToggleComponent,
  Menu,
  Notice,
} from "obsidian";
import type StashpaperPlugin from "./main";
import {
  ChangeNotebookModal,
  ManageTagsModal,
  ConfirmDeleteModal,
} from "./explorerModals";

export const STASHPAPER_EXPLORER_VIEW = "stashpaper-explorer-view";

export interface StashpaperArticleItem {
  file: TFile;
  title: string;
  sourceUrl: string;
  dateSaved: string;
  dateSavedTimestamp: number;
  status: string; // 'unread' | 'reading' | 'done' | string
  progress: number; // 0 to 100
  readingTimeMinutes: number;
  notebook?: string;
  tags: string[];
  author?: string;
}

/**
 * Normalizes tags from frontmatter into a clean array of tag strings without '#'.
 */
function normalizeTags(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((t) => String(t).trim().replace(/^#+/, ""))
      .filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split(/[\s,]+/)
      .map((t) => t.trim().replace(/^#+/, ""))
      .filter(Boolean);
  }
  return [];
}

export class StashpaperExplorerView extends ItemView {
  plugin: StashpaperPlugin;

  // Filter and sort states
  private searchQuery: string = "";
  private selectedStatus: string = "all";
  private selectedNotebook: string = "all";
  private selectedTags: string[] = [];
  private sortOrder: string = "date-desc";
  private groupByNotebook: boolean = false;
  private isTagDropdownOpen: boolean = false;
  private collapsedNotebooks: Set<string> = new Set();
  private selectedArticlePaths: Set<string> = new Set();
  private lastClickedArticlePath: string | null = null;

  // Cached data
  private allArticles: StashpaperArticleItem[] = [];
  private availableNotebooks: string[] = [];
  private availableTags: { name: string; count: number }[] = [];

  // DOM elements
  private headerEl!: HTMLElement;
  private searchInput!: HTMLInputElement;
  private searchClearBtn!: HTMLElement;
  private statusSelect!: HTMLSelectElement;
  private notebookSelect!: HTMLSelectElement;
  private tagTriggerBtn!: HTMLButtonElement;
  private tagPopoverEl!: HTMLElement;
  private activeTagsRowEl!: HTMLElement;
  private sortSelect!: HTMLSelectElement;
  private toggleComponent!: ToggleComponent;
  private statsRowEl!: HTMLElement;
  private listEl!: HTMLElement;

  private refreshTimeout: number | null = null;
  private documentClickHandler: ((e: MouseEvent) => void) | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: StashpaperPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return STASHPAPER_EXPLORER_VIEW;
  }

  getDisplayText(): string {
    return "Stashpaper Explorer";
  }

  getIcon(): string {
    return "book-open";
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("stashpaper-explorer-container");

    this.buildLayout();

    // Subscribe to metadata and vault events so the view updates automatically
    this.registerEvent(
      (this.app.workspace as any).on(
        "stashpaper:progress-updated",
        (filePath: string, progress: number, status: string) => {
          const art = this.allArticles.find((a) => a.file.path === filePath);
          if (art) {
            const oldStatus = art.status;
            art.progress = progress;
            art.status = status;
            // Only do a full re-render when the status filter is active and the
            // status transition would change which articles are visible. Otherwise
            // patch just the affected card so collapsed notebook groups are kept.
            const visibilityChanged =
              this.selectedStatus !== "all" && oldStatus !== status;
            if (visibilityChanged) {
              this.renderArticles();
            } else {
              this.patchCardInPlace(filePath, progress, status);
            }
          }
        }
      )
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", () => this.scheduleRefresh())
    );
    this.registerEvent(
      this.app.metadataCache.on("resolve", () => this.scheduleRefresh())
    );
    this.registerEvent(
      this.app.vault.on("create", () => this.scheduleRefresh())
    );
    this.registerEvent(
      this.app.vault.on("delete", () => this.scheduleRefresh())
    );
    this.registerEvent(
      this.app.vault.on("rename", () => this.scheduleRefresh())
    );

    // Close tag popover on clicks outside
    this.documentClickHandler = (e: MouseEvent) => {
      if (!this.isTagDropdownOpen) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        !this.tagPopoverEl.contains(target) &&
        !this.tagTriggerBtn.contains(target)
      ) {
        this.closeTagPopover();
      }
    };
    document.addEventListener("click", this.documentClickHandler);

    // Escape key clears multi-selection
    this.registerDomEvent(window, "keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape" && this.selectedArticlePaths.size > 0) {
        this.selectedArticlePaths.clear();
        this.updateCardSelectionVisuals();
      }
    });

    // Clicking empty space in list clears selection
    this.listEl.addEventListener("click", (e: MouseEvent) => {
      if (e.target === this.listEl && this.selectedArticlePaths.size > 0) {
        this.selectedArticlePaths.clear();
        this.updateCardSelectionVisuals();
      }
    });

    // Initial data load and render
    this.refreshData();
  }

  async onClose(): Promise<void> {
    if (this.refreshTimeout) {
      window.clearTimeout(this.refreshTimeout);
      this.refreshTimeout = null;
    }
    if (this.documentClickHandler) {
      document.removeEventListener("click", this.documentClickHandler);
      this.documentClickHandler = null;
    }
  }

  /**
   * Debounced refresh to handle rapid batch file changes smoothly without lag.
   */
  private scheduleRefresh(): void {
    if (this.refreshTimeout) {
      window.clearTimeout(this.refreshTimeout);
    }
    this.refreshTimeout = window.setTimeout(() => {
      this.refreshTimeout = null;
      this.refreshData();
    }, 100);
  }

  /**
   * Builds the static skeleton layout (search bar, filter controls, list container).
   */
  private buildLayout(): void {
    const { contentEl } = this;

    // Header container (Sticky at top)
    this.headerEl = contentEl.createDiv({ cls: "stashpaper-explorer-header" });

    // ── a. Search Input ──
    const searchWrapper = this.headerEl.createDiv({
      cls: "stashpaper-search-wrapper",
    });
    const searchIconEl = searchWrapper.createSpan({
      cls: "stashpaper-search-icon",
    });
    setIcon(searchIconEl, "search");

    this.searchInput = searchWrapper.createEl("input", {
      type: "search",
      cls: "stashpaper-search-input",
      attr: {
        placeholder: "Search title, tag, notebook…",
        autocomplete: "off",
        spellcheck: "false",
      },
    });

    this.searchClearBtn = searchWrapper.createSpan({
      cls: "stashpaper-search-clear is-hidden",
      attr: { "aria-label": "Clear search", role: "button" },
    });
    setIcon(this.searchClearBtn, "x");

    this.searchInput.addEventListener("input", () => {
      this.searchQuery = this.searchInput.value;
      if (this.searchQuery) {
        this.searchClearBtn.removeClass("is-hidden");
      } else {
        this.searchClearBtn.addClass("is-hidden");
      }
      this.renderArticles();
    });

    this.searchClearBtn.addEventListener("click", () => {
      this.searchInput.value = "";
      this.searchQuery = "";
      this.searchClearBtn.addClass("is-hidden");
      this.searchInput.focus();
      this.renderArticles();
    });

    // ── b. Filter row (Status, Notebook, Tag multi-select) ──
    const filterRow = this.headerEl.createDiv({ cls: "stashpaper-filter-row" });

    // Status dropdown
    const statusWrapper = filterRow.createDiv({
      cls: "stashpaper-filter-item stashpaper-status-wrapper",
    });
    this.statusSelect = statusWrapper.createEl("select", {
      cls: "dropdown stashpaper-dropdown",
    });
    const statusOptions = [
      { val: "all", label: "All statuses" },
      { val: "unread", label: "Unread" },
      { val: "reading", label: "Reading" },
      { val: "done", label: "Done" },
    ];
    for (const opt of statusOptions) {
      const el = this.statusSelect.createEl("option", {
        value: opt.val,
        text: opt.label,
      });
      if (opt.val === this.selectedStatus) el.selected = true;
    }
    this.statusSelect.addEventListener("change", () => {
      this.selectedStatus = this.statusSelect.value;
      this.renderArticles();
    });

    // Notebook dropdown
    const notebookWrapper = filterRow.createDiv({
      cls: "stashpaper-filter-item stashpaper-notebook-wrapper",
    });
    this.notebookSelect = notebookWrapper.createEl("select", {
      cls: "dropdown stashpaper-dropdown",
    });
    this.updateNotebookOptions();
    this.notebookSelect.addEventListener("change", () => {
      this.selectedNotebook = this.notebookSelect.value;
      this.renderArticles();
    });

    // Tag multi-select trigger button
    const tagWrapper = filterRow.createDiv({
      cls: "stashpaper-filter-item stashpaper-tag-filter-wrapper",
    });
    this.tagTriggerBtn = tagWrapper.createEl("button", {
      cls: "stashpaper-tag-trigger-btn",
      attr: { type: "button" },
    });
    this.tagTriggerBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleTagPopover();
    });
    this.updateTagTriggerButton();

    // Tag Popover Container (initially hidden)
    this.tagPopoverEl = this.headerEl.createDiv({
      cls: "stashpaper-tag-popover is-hidden",
    });

    // Active tags row (visible when selectedTags.length > 0)
    this.activeTagsRowEl = this.headerEl.createDiv({
      cls: "stashpaper-active-tags-row is-hidden",
    });

    // ── c & d. Sort dropdown & "Group by notebook" toggle ──
    const controlsRow = this.headerEl.createDiv({
      cls: "stashpaper-controls-row",
    });

    // Sort dropdown
    const sortWrapper = controlsRow.createDiv({ cls: "stashpaper-sort-wrapper" });
    this.sortSelect = sortWrapper.createEl("select", {
      cls: "dropdown stashpaper-dropdown",
    });
    const sortOptions = [
      { val: "date-desc", label: "Date saved (newest first)" },
      { val: "date-asc", label: "Date saved (oldest first)" },
      { val: "reading-time-asc", label: "Reading time (shortest first)" },
      { val: "reading-time-desc", label: "Reading time (longest first)" },
      { val: "title-asc", label: "Title (A–Z)" },
    ];
    for (const opt of sortOptions) {
      const el = this.sortSelect.createEl("option", {
        value: opt.val,
        text: opt.label,
      });
      if (opt.val === this.sortOrder) el.selected = true;
    }
    this.sortSelect.addEventListener("change", () => {
      this.sortOrder = this.sortSelect.value;
      this.renderArticles();
    });

    // "Group by notebook" toggle switch
    const toggleWrapper = controlsRow.createDiv({
      cls: "stashpaper-toggle-wrapper",
    });
    toggleWrapper.createSpan({
      cls: "stashpaper-toggle-label",
      text: "Group by notebook",
    });
    this.toggleComponent = new ToggleComponent(toggleWrapper);
    this.toggleComponent.setValue(this.groupByNotebook);
    this.toggleComponent.onChange((val) => {
      this.groupByNotebook = val;
      this.renderArticles();
    });

    // Stats / Summary row
    this.statsRowEl = this.headerEl.createDiv({ cls: "stashpaper-stats-row" });

    // ── e. Articles List Container ──
    this.listEl = contentEl.createDiv({ cls: "stashpaper-articles-list" });
  }

  /**
   * Reads from MetadataCache only (no file disk reading) to identify all Stashpaper articles.
   */
  collectArticles(): StashpaperArticleItem[] {
    const markdownFiles = this.app.vault.getMarkdownFiles();
    const articles: StashpaperArticleItem[] = [];

    for (const file of markdownFiles) {
      const cache = this.app.metadataCache.getFileCache(file);
      const frontmatter = cache?.frontmatter;
      if (!frontmatter) continue;

      // Identify Stashpaper article by presence of source_url
      const sourceUrl = frontmatter.source_url;
      if (!sourceUrl || typeof sourceUrl !== "string") continue;

      // Title
      const title =
        typeof frontmatter.title === "string" && frontmatter.title.trim()
          ? frontmatter.title.trim()
          : file.basename;

      // Date saved & sort timestamp
      const rawDate = frontmatter.date_saved;
      let dateSaved = "";
      let dateSavedTimestamp = 0;

      if (typeof rawDate === "string") {
        dateSaved = rawDate.trim();
        const parsed = Date.parse(dateSaved);
        dateSavedTimestamp = isNaN(parsed)
          ? file.stat.ctime || file.stat.mtime
          : parsed;
      } else if (rawDate instanceof Date) {
        dateSaved = rawDate.toISOString().split("T")[0];
        dateSavedTimestamp = rawDate.getTime();
      } else if (typeof rawDate === "number") {
        dateSavedTimestamp = rawDate;
        dateSaved = new Date(rawDate).toISOString().split("T")[0];
      } else {
        dateSavedTimestamp = file.stat.ctime || file.stat.mtime;
        dateSaved = new Date(dateSavedTimestamp).toISOString().split("T")[0];
      }

      // Status
      const status =
        typeof frontmatter.status === "string" && frontmatter.status.trim()
          ? frontmatter.status.toLowerCase().trim()
          : "unread";

      // Progress (0 to 100)
      let progress = 0;
      const rawProgress = frontmatter.progress;
      if (typeof rawProgress === "number") {
        if (rawProgress > 0 && rawProgress <= 1) {
          progress = Math.round(rawProgress * 100);
        } else {
          progress = Math.max(0, Math.min(100, Math.round(rawProgress)));
        }
      } else if (typeof rawProgress === "string") {
        const parsed = parseFloat(rawProgress.replace("%", "").trim());
        if (!isNaN(parsed)) {
          progress = Math.max(0, Math.min(100, Math.round(parsed)));
        }
      }

      // Reading time minutes
      let readingTimeMinutes = 0;
      const rawReadingTime = frontmatter.reading_time_minutes;
      if (typeof rawReadingTime === "number") {
        readingTimeMinutes = Math.max(0, Math.round(rawReadingTime));
      } else if (typeof rawReadingTime === "string") {
        const parsed = parseInt(rawReadingTime, 10);
        if (!isNaN(parsed)) {
          readingTimeMinutes = Math.max(0, parsed);
        }
      }

      // Notebook
      let notebook: string | undefined = undefined;
      if (
        typeof frontmatter.notebook === "string" &&
        frontmatter.notebook.trim()
      ) {
        notebook = frontmatter.notebook.trim();
      }

      // Tags
      const tags = normalizeTags(frontmatter.tags);

      // Author
      let author: string | undefined = undefined;
      if (typeof frontmatter.author === "string" && frontmatter.author.trim()) {
        author = frontmatter.author.trim();
      }

      articles.push({
        file,
        title,
        sourceUrl,
        dateSaved,
        dateSavedTimestamp,
        status,
        progress,
        readingTimeMinutes,
        notebook,
        tags,
        author,
      });
    }

    return articles;
  }

  /**
   * Refreshes metadata, updates dropdown options, and renders the article cards.
   */
  refreshData(): void {
    this.allArticles = this.collectArticles();

    // Extract dynamic notebooks
    const notebooksSet = new Set<string>();
    for (const a of this.allArticles) {
      if (a.notebook) {
        notebooksSet.add(a.notebook);
      }
    }
    this.availableNotebooks = Array.from(notebooksSet).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" })
    );

    // Extract dynamic tags with article counts
    const tagCountMap = new Map<string, number>();
    for (const a of this.allArticles) {
      for (const t of a.tags) {
        const count = tagCountMap.get(t) || 0;
        tagCountMap.set(t, count + 1);
      }
    }
    this.availableTags = Array.from(tagCountMap.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

    // Clean up selected tags that no longer exist
    this.selectedTags = this.selectedTags.filter((t) => tagCountMap.has(t));

    // Update Notebook dropdown options
    this.updateNotebookOptions();

    // Update Tag button & popover
    this.updateTagTriggerButton();
    if (this.isTagDropdownOpen) {
      this.renderTagPopover();
    }

    // Render articles & empty states
    this.renderArticles();
  }

  /**
   * Updates the notebook dropdown items while preserving active selection if valid.
   */
  private updateNotebookOptions(): void {
    const currentVal = this.selectedNotebook;
    this.notebookSelect.empty();

    const allOpt = this.notebookSelect.createEl("option", {
      value: "all",
      text: "All notebooks",
    });
    if (currentVal === "all") allOpt.selected = true;

    let hasCurrent = currentVal === "all";
    for (const nb of this.availableNotebooks) {
      const opt = this.notebookSelect.createEl("option", {
        value: nb,
        text: nb,
      });
      if (nb === currentVal) {
        opt.selected = true;
        hasCurrent = true;
      }
    }

    if (!hasCurrent) {
      this.selectedNotebook = "all";
      allOpt.selected = true;
    }
  }

  /**
   * Updates the label and active badge of the tag trigger button.
   */
  private updateTagTriggerButton(): void {
    this.tagTriggerBtn.empty();
    const iconSpan = this.tagTriggerBtn.createSpan({ cls: "stashpaper-tag-btn-icon" });
    setIcon(iconSpan, "tag");

    const textSpan = this.tagTriggerBtn.createSpan({ cls: "stashpaper-tag-btn-text" });
    if (this.selectedTags.length === 0) {
      textSpan.setText("Tags: All ▾");
      this.tagTriggerBtn.removeClass("is-active");
    } else if (this.selectedTags.length === 1) {
      textSpan.setText(`Tag: #${this.selectedTags[0]} ▾`);
      this.tagTriggerBtn.addClass("is-active");
    } else {
      textSpan.setText(`Tags: (${this.selectedTags.length}) ▾`);
      this.tagTriggerBtn.addClass("is-active");
    }
  }

  /**
   * Toggles the tag selection popover menu.
   */
  private toggleTagPopover(): void {
    if (this.isTagDropdownOpen) {
      this.closeTagPopover();
    } else {
      this.openTagPopover();
    }
  }

  private openTagPopover(): void {
    this.isTagDropdownOpen = true;
    this.tagPopoverEl.removeClass("is-hidden");
    this.renderTagPopover();
  }

  private closeTagPopover(): void {
    this.isTagDropdownOpen = false;
    this.tagPopoverEl.addClass("is-hidden");
  }

  /**
   * Renders the interactive tag multi-select popover with checkboxes and article counts.
   */
  private renderTagPopover(): void {
    this.tagPopoverEl.empty();

    const popoverHeader = this.tagPopoverEl.createDiv({
      cls: "stashpaper-tag-popover-header",
    });
    popoverHeader.createSpan({
      cls: "stashpaper-tag-popover-title",
      text: "Filter by tags (OR)",
    });

    const headerActions = popoverHeader.createDiv({
      cls: "stashpaper-tag-popover-actions",
    });

    if (this.selectedTags.length > 0) {
      const clearBtn = headerActions.createEl("button", {
        cls: "stashpaper-tag-popover-action-btn",
        text: "Clear",
        attr: { type: "button" },
      });
      clearBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.selectedTags = [];
        this.updateTagTriggerButton();
        this.renderTagPopover();
        this.renderArticles();
      });
    }

    const closeBtn = headerActions.createSpan({
      cls: "stashpaper-tag-popover-close",
      attr: { "aria-label": "Close", role: "button" },
    });
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.closeTagPopover();
    });

    if (this.availableTags.length === 0) {
      const emptyNotice = this.tagPopoverEl.createDiv({
        cls: "stashpaper-tag-popover-empty",
      });
      emptyNotice.setText("No tags found across saved articles.");
      return;
    }

    const listContainer = this.tagPopoverEl.createDiv({
      cls: "stashpaper-tag-popover-list",
    });

    for (const tagInfo of this.availableTags) {
      const itemRow = listContainer.createDiv({
        cls: "stashpaper-tag-popover-item",
      });
      const isSelected = this.selectedTags.includes(tagInfo.name);
      if (isSelected) itemRow.addClass("is-selected");

      const checkbox = itemRow.createEl("input", {
        type: "checkbox",
        cls: "stashpaper-tag-checkbox",
      });
      checkbox.checked = isSelected;

      const nameSpan = itemRow.createSpan({
        cls: "stashpaper-tag-name",
        text: `#${tagInfo.name}`,
      });

      const countSpan = itemRow.createSpan({
        cls: "stashpaper-tag-count",
        text: String(tagInfo.count),
      });

      itemRow.addEventListener("click", (e) => {
        e.stopPropagation();
        if (this.selectedTags.includes(tagInfo.name)) {
          this.selectedTags = this.selectedTags.filter((t) => t !== tagInfo.name);
        } else {
          this.selectedTags.push(tagInfo.name);
        }
        this.updateTagTriggerButton();
        this.renderTagPopover();
        this.renderArticles();
      });
    }
  }

  /**
   * Renders active tag chips below the filter row when tags are selected.
   */
  private renderActiveTagsRow(): void {
    this.activeTagsRowEl.empty();

    if (this.selectedTags.length === 0) {
      this.activeTagsRowEl.addClass("is-hidden");
      return;
    }

    this.activeTagsRowEl.removeClass("is-hidden");

    this.activeTagsRowEl.createSpan({
      cls: "stashpaper-active-tags-label",
      text: "Active tags:",
    });

    const pillsWrap = this.activeTagsRowEl.createDiv({
      cls: "stashpaper-active-tags-pills",
    });

    for (const tag of this.selectedTags) {
      const pill = pillsWrap.createSpan({
        cls: "stashpaper-tag-pill is-filter-pill",
      });
      pill.createSpan({ text: `#${tag}` });

      const removeBtn = pill.createEl("button", {
        cls: "stashpaper-tag-remove",
        attr: { "aria-label": `Remove tag ${tag}` },
      });
      removeBtn.setText("✕");
      removeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.selectedTags = this.selectedTags.filter((t) => t !== tag);
        this.updateTagTriggerButton();
        if (this.isTagDropdownOpen) this.renderTagPopover();
        this.renderArticles();
      });
    }

    const clearAllBtn = this.activeTagsRowEl.createEl("button", {
      cls: "stashpaper-clear-all-tags-btn",
      text: "Clear all",
      attr: { type: "button" },
    });
    clearAllBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.selectedTags = [];
      this.updateTagTriggerButton();
      if (this.isTagDropdownOpen) this.renderTagPopover();
      this.renderArticles();
    });
  }

  /**
   * Filters and sorts the articles per user controls.
   */
  private filterAndSortArticles(): StashpaperArticleItem[] {
    const q = this.searchQuery.toLowerCase().trim();
    const statusFilter = this.selectedStatus.toLowerCase().trim();
    const notebookFilter = this.selectedNotebook.toLowerCase().trim();
    const selectedTagsLower = this.selectedTags.map((t) => t.toLowerCase());

    const filtered = this.allArticles.filter((article) => {
      // 4a. Live search against title, tags, and notebook (case-insensitive)
      if (q) {
        const titleMatch = article.title.toLowerCase().includes(q);
        const notebookMatch = article.notebook
          ? article.notebook.toLowerCase().includes(q)
          : false;
        const tagMatch = article.tags.some((t) => t.toLowerCase().includes(q));

        if (!titleMatch && !notebookMatch && !tagMatch) {
          return false;
        }
      }

      // 4b. Status filter
      if (statusFilter !== "all") {
        if (article.status.toLowerCase() !== statusFilter) {
          return false;
        }
      }

      // 4b. Notebook filter
      if (notebookFilter !== "all") {
        if (
          !article.notebook ||
          article.notebook.toLowerCase() !== notebookFilter
        ) {
          return false;
        }
      }

      // 4b. Tag multi-select filter (OR logic: match ANY selected tag)
      if (selectedTagsLower.length > 0) {
        const articleTagsLower = article.tags.map((t) => t.toLowerCase());
        const hasMatch = selectedTagsLower.some((t) =>
          articleTagsLower.includes(t)
        );
        if (!hasMatch) {
          return false;
        }
      }

      return true;
    });

    // 4c. Sort order
    filtered.sort((a, b) => {
      switch (this.sortOrder) {
        case "date-asc":
          return a.dateSavedTimestamp - b.dateSavedTimestamp;
        case "reading-time-asc":
          return a.readingTimeMinutes - b.readingTimeMinutes;
        case "reading-time-desc":
          return b.readingTimeMinutes - a.readingTimeMinutes;
        case "title-asc":
          return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
        case "date-desc":
        default:
          return b.dateSavedTimestamp - a.dateSavedTimestamp;
      }
    });

    return filtered;
  }

  /**
   * Resets all search queries and filters to their defaults.
   */
  resetFilters(): void {
    this.searchQuery = "";
    this.searchInput.value = "";
    this.searchClearBtn.addClass("is-hidden");

    this.selectedStatus = "all";
    this.statusSelect.value = "all";

    this.selectedNotebook = "all";
    this.notebookSelect.value = "all";

    this.selectedTags = [];
    this.updateTagTriggerButton();
    this.closeTagPopover();

    this.renderArticles();
  }

  /**
   * Renders the articles list, stats row, and empty states.
   */
  private renderArticles(): void {
    this.renderActiveTagsRow();

    const filtered = this.filterAndSortArticles();
    const hasFiltersActive =
      Boolean(this.searchQuery.trim()) ||
      this.selectedStatus !== "all" ||
      this.selectedNotebook !== "all" ||
      this.selectedTags.length > 0;

    // ── Update stats / count summary ──
    this.statsRowEl.empty();
    if (this.allArticles.length > 0) {
      const countSpan = this.statsRowEl.createSpan({ cls: "stashpaper-stats-text" });
      if (hasFiltersActive) {
        countSpan.setText(`Showing ${filtered.length} of ${this.allArticles.length} articles`);

        const clearBtn = this.statsRowEl.createEl("button", {
          cls: "stashpaper-clear-filters-link",
          text: "Reset filters",
          attr: { type: "button" },
        });
        clearBtn.addEventListener("click", () => this.resetFilters());
      } else {
        countSpan.setText(
          `${this.allArticles.length} ${
            this.allArticles.length === 1 ? "article" : "articles"
          }`
        );
      }

      // Multi-select banner in stats row
      if (this.selectedArticlePaths.size > 0) {
        const banner = this.statsRowEl.createDiv({
          cls: "stashpaper-selection-banner",
        });
        banner.createSpan({
          cls: "stashpaper-selection-count",
          text: `${this.selectedArticlePaths.size} selected`,
        });
        const deselectBtn = banner.createEl("button", {
          cls: "stashpaper-selection-clear-btn",
          text: "Deselect all",
          attr: { type: "button" },
        });
        deselectBtn.addEventListener("click", () => {
          this.selectedArticlePaths.clear();
          this.updateCardSelectionVisuals();
        });
      }
    }

    // ── Render article list or empty state ──
    this.listEl.empty();

    // 5. Empty State 1: Zero articles in vault at all
    if (this.allArticles.length === 0) {
      const emptyState = this.listEl.createDiv({ cls: "stashpaper-empty-state" });
      const iconEl = emptyState.createDiv({ cls: "stashpaper-empty-icon" });
      setIcon(iconEl, "book-open");

      emptyState.createDiv({
        cls: "stashpaper-empty-title",
        text: "No articles saved yet.",
      });
      emptyState.createDiv({
        cls: "stashpaper-empty-desc",
        text: "Use 'Stashpaper: Save article' to get started.",
      });

      const saveBtn = emptyState.createEl("button", {
        cls: "mod-cta stashpaper-empty-btn",
        text: "Save an article",
      });
      saveBtn.addEventListener("click", () => {
        this.plugin.openSaveModal();
      });
      return;
    }

    // 5. Empty State 2: Filters/search produce zero results
    if (filtered.length === 0) {
      const emptyState = this.listEl.createDiv({ cls: "stashpaper-empty-state" });
      const iconEl = emptyState.createDiv({ cls: "stashpaper-empty-icon" });
      setIcon(iconEl, "search-x");

      emptyState.createDiv({
        cls: "stashpaper-empty-title",
        text: "No articles match your current filters.",
      });

      const clearBtn = emptyState.createEl("button", {
        cls: "stashpaper-clear-filters-btn",
        text: "Clear filters",
      });
      clearBtn.addEventListener("click", () => {
        this.resetFilters();
      });
      return;
    }

    // 4e. Render Article Cards (grouped by notebook or flat list)
    if (this.groupByNotebook) {
      // Group articles by notebook (notes with no notebook go under "Uncategorized")
      const groups = new Map<string, StashpaperArticleItem[]>();
      for (const article of filtered) {
        const groupName = article.notebook?.trim() || "Uncategorized";
        let groupList = groups.get(groupName);
        if (!groupList) {
          groupList = [];
          groups.set(groupName, groupList);
        }
        groupList.push(article);
      }

      // Sort group names: named notebooks first (alphabetical), "Uncategorized" at the end
      const groupNames = Array.from(groups.keys()).sort((a, b) => {
        if (a === "Uncategorized") return 1;
        if (b === "Uncategorized") return -1;
        return a.localeCompare(b, undefined, { sensitivity: "base" });
      });

      for (const groupName of groupNames) {
        const groupArticles = groups.get(groupName) || [];
        const isCollapsed = this.collapsedNotebooks.has(groupName);

        const groupSection = this.listEl.createDiv({
          cls: "stashpaper-notebook-group",
        });

        // Group Header
        const groupHeader = groupSection.createDiv({
          cls: `stashpaper-notebook-group-header ${isCollapsed ? "is-collapsed" : ""}`,
          attr: {
            role: "button",
            tabindex: "0",
            "aria-label": `Toggle notebook group ${groupName}`,
          },
        });

        const chevronEl = groupHeader.createSpan({
          cls: "stashpaper-group-chevron",
        });
        setIcon(chevronEl, isCollapsed ? "chevron-right" : "chevron-down");

        const iconEl = groupHeader.createSpan({
          cls: "stashpaper-group-icon",
        });
        setIcon(iconEl, groupName === "Uncategorized" ? "folder" : "book-open");

        groupHeader.createSpan({
          cls: "stashpaper-group-title",
          text: groupName,
        });

        groupHeader.createSpan({
          cls: "stashpaper-group-count",
          text: String(groupArticles.length),
        });

        // Items container
        const itemsContainer = groupSection.createDiv({
          cls: `stashpaper-notebook-group-items ${isCollapsed ? "is-hidden" : ""}`,
        });

        for (const article of groupArticles) {
          this.renderArticleCard(itemsContainer, article);
        }

        const toggleCollapse = () => {
          if (this.collapsedNotebooks.has(groupName)) {
            this.collapsedNotebooks.delete(groupName);
            groupHeader.removeClass("is-collapsed");
            itemsContainer.removeClass("is-hidden");
            setIcon(chevronEl, "chevron-down");
          } else {
            this.collapsedNotebooks.add(groupName);
            groupHeader.addClass("is-collapsed");
            itemsContainer.addClass("is-hidden");
            setIcon(chevronEl, "chevron-right");
          }
        };

        groupHeader.addEventListener("click", toggleCollapse);
        groupHeader.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleCollapse();
          }
        });
      }
    } else {
      // Flat list per the current sort order
      for (const article of filtered) {
        this.renderArticleCard(this.listEl, article);
      }
    }
  }

  /**
   * Renders a single article card with title, status, progress bar, tags, and click handler.
   */
  private renderArticleCard(
    container: HTMLElement,
    article: StashpaperArticleItem
  ): void {
    const isSelected = this.selectedArticlePaths.has(article.file.path);
    const card = container.createDiv({
      cls: `stashpaper-article-card ${isSelected ? "is-selected" : ""}`,
      attr: {
        role: "button",
        tabindex: "0",
        "aria-label": `Open article ${article.title}`,
        "data-file-path": article.file.path,
      },
    });

    // Card Header: Title + Status Badge
    const cardHeader = card.createDiv({ cls: "stashpaper-article-card-header" });
    cardHeader.createDiv({
      cls: "stashpaper-article-title",
      text: article.title,
    });

    cardHeader.createSpan({
      cls: `stashpaper-status-badge status-${article.status}`,
      text: article.status,
    });

    // Progress bar track (thin 3px line)
    const progressTrack = card.createDiv({
      cls: "stashpaper-article-progress-track",
    });
    const progressBar = progressTrack.createDiv({
      cls: "stashpaper-article-progress-bar",
    });
    progressBar.style.width = `${article.progress}%`;

    // Metadata row: Progress % / Reading time / Notebook / Date
    const metaRow = card.createDiv({ cls: "stashpaper-article-meta" });

    if (article.progress > 0) {
      const progressLabel = metaRow.createSpan({
        cls: "stashpaper-meta-item stashpaper-meta-progress",
      });
      progressLabel.setText(`${article.progress}%`);
    }

    if (article.readingTimeMinutes > 0) {
      const timeLabel = metaRow.createSpan({
        cls: "stashpaper-meta-item stashpaper-meta-reading-time",
      });
      timeLabel.setText(`${article.readingTimeMinutes} min`);
    }

    if (article.notebook) {
      const notebookLabel = metaRow.createSpan({
        cls: "stashpaper-meta-item stashpaper-meta-notebook",
      });
      notebookLabel.setText(article.notebook);
    }

    if (article.dateSaved) {
      const dateLabel = metaRow.createSpan({
        cls: "stashpaper-meta-item stashpaper-meta-date",
      });
      dateLabel.setText(article.dateSaved);
    }

    // Tag chips (one per tag)
    if (article.tags.length > 0) {
      const tagsContainer = card.createDiv({
        cls: "stashpaper-article-tags",
      });
      for (const tag of article.tags) {
        const pill = tagsContainer.createSpan({
          cls: "stashpaper-tag-pill stashpaper-article-tag-chip",
          text: `#${tag}`,
        });

        // Tapping a tag chip directly activates filtering by that tag
        pill.addEventListener("click", (e) => {
          e.stopPropagation();
          if (!this.selectedTags.includes(tag)) {
            this.selectedTags.push(tag);
            this.updateTagTriggerButton();
            if (this.isTagDropdownOpen) this.renderTagPopover();
            this.renderArticles();
          }
        });
      }
    }

    // Click to open file in Reading View in active leaf or new tab
    const openArticle = async () => {
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(article.file, { state: { mode: "preview" } });
    };

    // Left click handling (with multi-select & range select support)
    card.addEventListener("click", async (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest(".stashpaper-article-tag-chip")) {
        return;
      }

      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        if (this.selectedArticlePaths.has(article.file.path)) {
          this.selectedArticlePaths.delete(article.file.path);
        } else {
          this.selectedArticlePaths.add(article.file.path);
        }
        this.lastClickedArticlePath = article.file.path;
        this.updateCardSelectionVisuals();
        return;
      }

      if (e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        this.handleRangeSelect(article.file.path);
        this.updateCardSelectionVisuals();
        return;
      }

      if (this.selectedArticlePaths.size > 0) {
        this.selectedArticlePaths.clear();
        this.updateCardSelectionVisuals();
      }

      this.lastClickedArticlePath = article.file.path;
      await openArticle();
    });

    // Right-click context menu
    card.addEventListener("contextmenu", (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();

      if (!this.selectedArticlePaths.has(article.file.path)) {
        this.selectedArticlePaths.clear();
        this.selectedArticlePaths.add(article.file.path);
        this.lastClickedArticlePath = article.file.path;
        this.updateCardSelectionVisuals();
      }

      this.openContextMenu(e);
    });

    // Touch / Mobile long-press support
    let longPressTimer: number | null = null;
    let startX = 0;
    let startY = 0;

    card.addEventListener(
      "touchstart",
      (e: TouchEvent) => {
        if (e.touches.length !== 1) return;
        const touch = e.touches[0];
        startX = touch.clientX;
        startY = touch.clientY;

        longPressTimer = window.setTimeout(() => {
          longPressTimer = null;
          if (!this.selectedArticlePaths.has(article.file.path)) {
            this.selectedArticlePaths.clear();
            this.selectedArticlePaths.add(article.file.path);
            this.lastClickedArticlePath = article.file.path;
            this.updateCardSelectionVisuals();
          }
          this.openContextMenuAtPosition(touch.clientX, touch.clientY);
        }, 500);
      },
      { passive: true }
    );

    card.addEventListener(
      "touchmove",
      (e: TouchEvent) => {
        if (!longPressTimer) return;
        const touch = e.touches[0];
        if (
          Math.abs(touch.clientX - startX) > 10 ||
          Math.abs(touch.clientY - startY) > 10
        ) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
      },
      { passive: true }
    );

    card.addEventListener("touchend", () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    });

    card.addEventListener("touchcancel", () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    });

    card.addEventListener("keydown", async (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        await openArticle();
      }
    });
  }

  /**
   * Surgically updates only the progress bar, percentage label, and status badge
   * of a single article card already rendered in the DOM. Avoids a full list
   * re-render so collapsed notebook groups stay collapsed during live tracking.
   */
  private patchCardInPlace(
    filePath: string,
    progress: number,
    status: string
  ): void {
    const escapedPath = filePath.replace(/"/g, '\\"');
    const card = this.listEl.querySelector<HTMLElement>(
      `[data-file-path="${escapedPath}"]`
    );
    if (!card) return;

    // ── Status badge ──
    const badge = card.querySelector<HTMLElement>(".stashpaper-status-badge");
    if (badge) {
      const baseClasses = Array.from(badge.classList).filter(
        (c) => !c.startsWith("status-")
      );
      badge.className = [...baseClasses, `status-${status}`].join(" ");
      badge.setText(status);
    }

    // ── Progress bar fill ──
    const progressBar = card.querySelector<HTMLElement>(
      ".stashpaper-article-progress-bar"
    );
    if (progressBar) {
      progressBar.style.width = `${progress}%`;
    }

    // ── Progress percentage label (add / update / remove) ──
    const metaRow = card.querySelector<HTMLElement>(".stashpaper-article-meta");
    if (metaRow) {
      let label = metaRow.querySelector<HTMLElement>(".stashpaper-meta-progress");
      if (progress > 0) {
        if (!label) {
          label = createEl("span", {
            cls: "stashpaper-meta-item stashpaper-meta-progress",
          });
          metaRow.prepend(label);
        }
        label.setText(`${progress}%`);
      } else if (label) {
        label.remove();
      }
    }
  }

  /**
   * Handles Shift-click range selection between last clicked article and target.
   */
  private handleRangeSelect(targetPath: string): void {
    const visibleArticles = this.filterAndSortArticles();
    const visiblePaths = visibleArticles.map((a) => a.file.path);

    const targetIdx = visiblePaths.indexOf(targetPath);
    if (targetIdx === -1) return;

    let startIdx = targetIdx;
    if (this.lastClickedArticlePath) {
      const prevIdx = visiblePaths.indexOf(this.lastClickedArticlePath);
      if (prevIdx !== -1) {
        startIdx = prevIdx;
      }
    }

    const minIdx = Math.min(startIdx, targetIdx);
    const maxIdx = Math.max(startIdx, targetIdx);

    for (let i = minIdx; i <= maxIdx; i++) {
      this.selectedArticlePaths.add(visiblePaths[i]);
    }
    this.lastClickedArticlePath = targetPath;
  }

  /**
   * Updates visual selected state on cards in the DOM and refreshes selection banner.
   */
  private updateCardSelectionVisuals(): void {
    const allCards = this.listEl.querySelectorAll<HTMLElement>(
      ".stashpaper-article-card"
    );
    allCards.forEach((card) => {
      const path = card.getAttribute("data-file-path");
      if (path && this.selectedArticlePaths.has(path)) {
        card.addClass("is-selected");
      } else {
        card.removeClass("is-selected");
      }
    });

    let banner = this.statsRowEl.querySelector<HTMLElement>(
      ".stashpaper-selection-banner"
    );
    if (this.selectedArticlePaths.size > 0) {
      if (!banner) {
        banner = this.statsRowEl.createDiv({
          cls: "stashpaper-selection-banner",
        });
      }
      banner.empty();
      banner.createSpan({
        cls: "stashpaper-selection-count",
        text: `${this.selectedArticlePaths.size} selected`,
      });
      const deselectBtn = banner.createEl("button", {
        cls: "stashpaper-selection-clear-btn",
        text: "Deselect all",
        attr: { type: "button" },
      });
      deselectBtn.addEventListener("click", () => {
        this.selectedArticlePaths.clear();
        this.updateCardSelectionVisuals();
      });
    } else if (banner) {
      banner.remove();
    }
  }

  /**
   * Opens native Obsidian context menu at MouseEvent position.
   */
  private openContextMenu(e: MouseEvent): void {
    const menu = this.buildContextMenu();
    menu.showAtMouseEvent(e);
  }

  /**
   * Opens native Obsidian context menu at screen coordinates (for mobile touch).
   */
  private openContextMenuAtPosition(x: number, y: number): void {
    const menu = this.buildContextMenu();
    menu.showAtPosition({ x, y });
  }

  /**
   * Constructs the native Menu with appropriate single vs. multi-select items.
   */
  private buildContextMenu(): Menu {
    const selectedArticles = this.allArticles.filter((a) =>
      this.selectedArticlePaths.has(a.file.path)
    );
    if (selectedArticles.length === 0) return new Menu();

    const isSingle = selectedArticles.length === 1;
    const targetArticle = selectedArticles[0];
    const menu = new Menu();

    // 1. "Open" — single article only
    if (isSingle) {
      menu.addItem((item) => {
        item
          .setTitle("Open")
          .setIcon("book-open")
          .onClick(async () => {
            const leaf = this.app.workspace.getLeaf(false);
            await leaf.openFile(targetArticle.file, { state: { mode: "preview" } });
          });
      });
    }

    // 2. "Archive" — sets status to done directly
    menu.addItem((item) => {
      item
        .setTitle(
          isSingle ? "Archive" : `Archive (${selectedArticles.length} articles)`
        )
        .setIcon("check-circle")
        .onClick(async () => {
          for (const art of selectedArticles) {
            await this.app.fileManager.processFrontMatter(art.file, (fm) => {
              fm.status = "done";
              fm.progress = 100;
            });
            art.status = "done";
            art.progress = 100;
            this.patchCardInPlace(art.file.path, 100, "done");
          }
          this.refreshData();
          new Notice(
            isSingle
              ? `Archived "${targetArticle.title}"`
              : `Archived ${selectedArticles.length} articles`
          );
        });
    });

    // 3. "Re-fetch article" — single article only
    if (isSingle) {
      menu.addItem((item) => {
        item
          .setTitle("Re-fetch article")
          .setIcon("refresh-cw")
          .onClick(async () => {
            try {
              await this.plugin.refetchArticle(targetArticle.file);
              this.refreshData();
            } catch {
              // notice shown inside refetchArticle
            }
          });
      });
    }

    // 4. "Change notebook..." — single & bulk
    menu.addItem((item) => {
      item
        .setTitle(
          isSingle
            ? "Change notebook..."
            : `Change notebook (${selectedArticles.length} articles)...`
        )
        .setIcon("book")
        .onClick(() => {
          new ChangeNotebookModal(
            this.app,
            this.plugin,
            selectedArticles,
            async () => {
              this.refreshData();
            }
          ).open();
        });
    });

    // 5. "Manage tags..." — single & bulk
    menu.addItem((item) => {
      item
        .setTitle(
          isSingle
            ? "Manage tags..."
            : `Manage tags (${selectedArticles.length} articles)...`
        )
        .setIcon("tag")
        .onClick(() => {
          new ManageTagsModal(
            this.app,
            this.plugin,
            selectedArticles,
            async () => {
              this.refreshData();
            }
          ).open();
        });
    });

    // 6. "Delete article" — single & bulk confirmation
    menu.addSeparator();
    menu.addItem((item) => {
      item
        .setTitle(
          isSingle ? "Delete article" : `Delete ${selectedArticles.length} articles`
        )
        .setIcon("trash-2")
        .setWarning(true)
        .onClick(() => {
          new ConfirmDeleteModal(
            this.app,
            selectedArticles,
            async () => {
              for (const art of selectedArticles) {
                await this.app.vault.delete(art.file);
              }
              this.selectedArticlePaths.clear();
              this.refreshData();
              new Notice(
                isSingle
                  ? `Deleted "${targetArticle.title}"`
                  : `Deleted ${selectedArticles.length} articles`
              );
            }
          ).open();
        });
    });

    return menu;
  }

}
