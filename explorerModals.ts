import { App, ButtonComponent, Modal, Notice, Platform } from "obsidian";
import type StashpaperPlugin from "./main";
import type { StashpaperArticleItem } from "./explorerView";

/**
 * Normalizes tags from frontmatter into a clean array of tag strings without '#'.
 */
export function normalizeTags(raw: unknown): string[] {
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

/**
 * Modal to change or clear the notebook for one or multiple articles.
 */
export class ChangeNotebookModal extends Modal {
  private articles: StashpaperArticleItem[];
  private plugin: StashpaperPlugin;
  private onDone: () => Promise<void> | void;
  private selectedNotebook: string = "";

  constructor(
    app: App,
    plugin: StashpaperPlugin,
    articles: StashpaperArticleItem[],
    onDone: () => Promise<void> | void
  ) {
    super(app);
    this.plugin = plugin;
    this.articles = articles;
    this.onDone = onDone;
    if (articles.length === 1 && articles[0].notebook) {
      this.selectedNotebook = articles[0].notebook;
    }
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("stashpaper-modal");
    contentEl.empty();

    const isSingle = this.articles.length === 1;
    this.titleEl.setText(
      isSingle
        ? `Change notebook: ${this.articles[0].title}`
        : `Change notebook (${this.articles.length} articles)`
    );

    contentEl.createEl("p", {
      text: isSingle
        ? "Select or type a notebook name. Leave empty to mark as Uncategorized."
        : `This will update the notebook for all ${this.articles.length} selected articles.`,
      cls: "stashpaper-modal-desc",
    });

    const wrapper = contentEl.createDiv({
      cls: "stashpaper-control-wrapper stashpaper-notebook-wrapper",
    });

    const input = wrapper.createEl("input", {
      type: "text",
      cls: "stashpaper-folder-input stashpaper-notebook-input",
      value: this.selectedNotebook,
      placeholder: "e.g. Tech, Reading, Research (leave empty for Uncategorized)",
    });

    const suggesterEl = wrapper.createDiv({
      cls: "stashpaper-suggester",
    });
    suggesterEl.hide();

    const getAvailableNotebooks = (): string[] => {
      const set = new Set<string>();
      const mdFiles = this.app.vault.getMarkdownFiles();
      for (const file of mdFiles) {
        const cache = this.app.metadataCache.getFileCache(file);
        const nb = cache?.frontmatter?.notebook;
        if (typeof nb === "string" && nb.trim()) {
          set.add(nb.trim());
        }
      }
      return Array.from(set).sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" })
      );
    };

    let highlightedIndex = -1;
    let currentOptions: string[] = [];

    const renderSuggestions = (query: string) => {
      suggesterEl.empty();
      const allNb = getAvailableNotebooks();
      const cleanQ = query.trim().toLowerCase();

      currentOptions = allNb.filter((nb) =>
        nb.toLowerCase().includes(cleanQ)
      );

      if (query.trim() && !allNb.some((n) => n.toLowerCase() === cleanQ)) {
        currentOptions.unshift(query.trim());
      }

      if (currentOptions.length === 0) {
        suggesterEl.hide();
        return;
      }

      currentOptions.forEach((opt, idx) => {
        const item = suggesterEl.createDiv({
          cls: `stashpaper-suggester-item ${idx === highlightedIndex ? "is-selected" : ""}`,
        });
        item.createSpan({ text: "📖 ", cls: "suggester-icon" });
        item.createSpan({ text: opt });
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          selectNotebook(opt);
        });
      });

      suggesterEl.show();
    };

    const selectNotebook = (val: string) => {
      this.selectedNotebook = val.trim();
      input.value = this.selectedNotebook;
      suggesterEl.hide();
    };

    input.addEventListener("focus", () => {
      highlightedIndex = -1;
      renderSuggestions(input.value);
    });

    input.addEventListener("input", () => {
      highlightedIndex = -1;
      renderSuggestions(input.value);
    });

    const outsideListener = (e: MouseEvent) => {
      if (!wrapper.contains(e.target as Node)) {
        suggesterEl.hide();
      }
    };
    document.addEventListener("pointerdown", outsideListener);

    input.addEventListener("keydown", async (e: KeyboardEvent) => {
      if (suggesterEl.isShown()) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          highlightedIndex = Math.min(highlightedIndex + 1, currentOptions.length - 1);
          renderSuggestions(input.value);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          highlightedIndex = Math.max(highlightedIndex - 1, 0);
          renderSuggestions(input.value);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          if (highlightedIndex >= 0 && currentOptions[highlightedIndex]) {
            e.preventDefault();
            selectNotebook(currentOptions[highlightedIndex]);
            return;
          }
        }
        if (e.key === "Escape") {
          e.preventDefault();
          suggesterEl.hide();
          return;
        }
      }

      if (e.key === "Enter") {
        e.preventDefault();
        await saveAction();
      }
    });

    // Button Row
    const btnRow = contentEl.createDiv({
      cls: "stashpaper-modal-btn-row",
    });

    const cancelBtn = new ButtonComponent(btnRow)
      .setButtonText("Cancel")
      .onClick(() => {
        document.removeEventListener("pointerdown", outsideListener);
        this.close();
      });

    const clearBtn = new ButtonComponent(btnRow)
      .setButtonText("Clear notebook (Uncategorized)")
      .onClick(async () => {
        document.removeEventListener("pointerdown", outsideListener);
        clearBtn.setDisabled(true);
        saveBtn.setDisabled(true);
        await this.applyNotebookChange(undefined);
      });

    const saveAction = async () => {
      document.removeEventListener("pointerdown", outsideListener);
      clearBtn.setDisabled(true);
      saveBtn.setDisabled(true);
      const val = input.value.trim() || undefined;
      await this.applyNotebookChange(val);
    };

    const saveBtn = new ButtonComponent(btnRow)
      .setButtonText("Save")
      .setCta()
      .onClick(saveAction);

    setTimeout(() => input.focus(), 50);
  }

  private async applyNotebookChange(notebook: string | undefined): Promise<void> {
    for (const art of this.articles) {
      await this.app.fileManager.processFrontMatter(art.file, (fm) => {
        if (notebook) {
          fm.notebook = notebook;
        } else {
          delete fm.notebook;
        }
      });
      art.notebook = notebook;
    }
    new Notice(
      this.articles.length === 1
        ? `Notebook set to "${notebook || "Uncategorized"}"`
        : `Updated notebook for ${this.articles.length} articles`
    );
    this.close();
    await this.onDone();
  }
}

/**
 * Modal to manage tags for one or multiple articles.
 */
export class ManageTagsModal extends Modal {
  private articles: StashpaperArticleItem[];
  private plugin: StashpaperPlugin;
  private onDone: () => Promise<void> | void;

  // Single article mode state
  private singleTags: string[] = [];

  // Multi article mode state
  private tagsToAdd: string[] = [];
  private tagsToRemove: Set<string> = new Set();
  private allExistingTags: Set<string> = new Set();

  constructor(
    app: App,
    plugin: StashpaperPlugin,
    articles: StashpaperArticleItem[],
    onDone: () => Promise<void> | void
  ) {
    super(app);
    this.plugin = plugin;
    this.articles = articles;
    this.onDone = onDone;

    if (articles.length === 1) {
      this.singleTags = [...articles[0].tags];
    } else {
      for (const art of articles) {
        for (const t of art.tags) {
          this.allExistingTags.add(t);
        }
      }
    }
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("stashpaper-modal");
    contentEl.empty();

    if (this.articles.length === 1) {
      this.renderSingleMode(contentEl);
    } else {
      this.renderMultiMode(contentEl);
    }
  }

  private getVaultTags(): string[] {
    const vaultTags = new Set<string>();
    const runtimeCache = this.app.metadataCache as unknown as {
      getTags?: () => Record<string, number>;
    };
    if (typeof runtimeCache.getTags === "function") {
      try {
        const tagsObj = runtimeCache.getTags() || {};
        Object.keys(tagsObj).forEach((t) => {
          const clean = t.replace(/^#+/, "").trim();
          if (clean) vaultTags.add(clean);
        });
      } catch {
        // ignore
      }
    }

    const mdFiles = this.app.vault.getMarkdownFiles();
    for (const file of mdFiles) {
      const cache = this.app.metadataCache.getFileCache(file);
      if (cache?.tags) {
        for (const t of cache.tags) {
          const clean = t.tag.replace(/^#+/, "").trim();
          if (clean) vaultTags.add(clean);
        }
      }
      const fmTags = normalizeTags(cache?.frontmatter?.tags);
      for (const t of fmTags) {
        vaultTags.add(t);
      }
    }

    return Array.from(vaultTags).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" })
    );
  }

  private renderSingleMode(contentEl: HTMLElement): void {
    this.titleEl.setText(`Manage tags: ${this.articles[0].title}`);

    contentEl.createEl("p", {
      text: "Add or remove tags for this article. Press Enter, Comma, or Space to add.",
      cls: "stashpaper-modal-desc",
    });

    const wrapper = contentEl.createDiv({
      cls: "stashpaper-control-wrapper",
    });

    const tagsBox = wrapper.createDiv({
      cls: "stashpaper-tags-box",
    });

    const pillsContainer = tagsBox.createDiv({
      cls: "stashpaper-pills-container",
      attr: { style: "display: contents;" },
    });

    const tagInput = tagsBox.createEl("input", {
      type: "text",
      cls: "stashpaper-tag-input",
      placeholder: "Add tags...",
    });

    const suggesterEl = wrapper.createDiv({
      cls: "stashpaper-suggester",
    });
    suggesterEl.hide();

    let highlightedIndex = -1;
    let currentOptions: string[] = [];

    const renderPills = () => {
      pillsContainer.empty();
      for (const tag of this.singleTags) {
        const pill = pillsContainer.createSpan({
          cls: "stashpaper-tag-pill",
          text: `#${tag}`,
        });

        const removeBtn = pill.createEl("button", {
          cls: "stashpaper-tag-remove",
          text: "✕",
          attr: { "aria-label": `Remove tag ${tag}` },
        });

        removeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.singleTags = this.singleTags.filter((t) => t !== tag);
          renderPills();
        });
      }
    };

    const addTag = (raw: string) => {
      const clean = raw.trim().replace(/^#+/, "").trim();
      if (!clean) return;
      if (!this.singleTags.includes(clean)) {
        this.singleTags.push(clean);
        renderPills();
      }
      tagInput.value = "";
      suggesterEl.hide();
    };

    const renderSuggestions = (query: string) => {
      suggesterEl.empty();
      const allTags = this.getVaultTags();
      const cleanQ = query.trim().toLowerCase().replace(/^#+/, "");

      currentOptions = allTags.filter(
        (t) => t.toLowerCase().includes(cleanQ) && !this.singleTags.includes(t)
      );

      if (cleanQ && !allTags.some((t) => t.toLowerCase() === cleanQ)) {
        currentOptions.unshift(cleanQ);
      }

      if (currentOptions.length === 0) {
        suggesterEl.hide();
        return;
      }

      currentOptions.forEach((opt, idx) => {
        const item = suggesterEl.createDiv({
          cls: `stashpaper-suggester-item ${idx === highlightedIndex ? "is-selected" : ""}`,
        });
        item.createSpan({ text: "# ", cls: "suggester-icon" });
        item.createSpan({ text: opt });
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          addTag(opt);
        });
      });

      suggesterEl.show();
    };

    tagsBox.addEventListener("click", () => tagInput.focus());

    tagInput.addEventListener("focus", () => {
      highlightedIndex = -1;
      renderSuggestions(tagInput.value);
    });

    tagInput.addEventListener("input", () => {
      highlightedIndex = -1;
      renderSuggestions(tagInput.value);
    });

    const outsideListener = (e: MouseEvent) => {
      if (!wrapper.contains(e.target as Node)) {
        suggesterEl.hide();
        if (tagInput.value.trim()) {
          addTag(tagInput.value.trim());
        }
      }
    };
    document.addEventListener("pointerdown", outsideListener);

    tagInput.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " " || e.key === ",") {
        e.preventDefault();
        if (suggesterEl.isShown() && highlightedIndex >= 0 && currentOptions[highlightedIndex]) {
          addTag(currentOptions[highlightedIndex]);
        } else if (tagInput.value.trim()) {
          addTag(tagInput.value.trim());
        }
        return;
      }

      if (e.key === "Backspace" && !tagInput.value && this.singleTags.length > 0) {
        this.singleTags.pop();
        renderPills();
        return;
      }

      if (suggesterEl.isShown()) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          highlightedIndex = Math.min(highlightedIndex + 1, currentOptions.length - 1);
          renderSuggestions(tagInput.value);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          highlightedIndex = Math.max(highlightedIndex - 1, 0);
          renderSuggestions(tagInput.value);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          suggesterEl.hide();
          return;
        }
      }
    });

    renderPills();

    // Button row
    const btnRow = contentEl.createDiv({
      cls: "stashpaper-modal-btn-row",
    });

    const cancelBtn = new ButtonComponent(btnRow)
      .setButtonText("Cancel")
      .onClick(() => {
        document.removeEventListener("pointerdown", outsideListener);
        this.close();
      });

    const saveBtn = new ButtonComponent(btnRow)
      .setButtonText("Save tags")
      .setCta()
      .onClick(async () => {
        document.removeEventListener("pointerdown", outsideListener);
        if (tagInput.value.trim()) {
          addTag(tagInput.value.trim());
        }
        saveBtn.setDisabled(true);
        cancelBtn.setDisabled(true);

        const targetFile = this.articles[0].file;
        await this.app.fileManager.processFrontMatter(targetFile, (fm) => {
          fm.tags = this.singleTags;
        });
        this.articles[0].tags = [...this.singleTags];

        new Notice(`Updated tags for "${this.articles[0].title}"`);
        this.close();
        await this.onDone();
      });

    setTimeout(() => tagInput.focus(), 50);
  }

  private renderMultiMode(contentEl: HTMLElement): void {
    this.titleEl.setText(`Manage tags (${this.articles.length} articles)`);

    contentEl.createEl("p", {
      text: "Add or remove tags across all selected articles.",
      cls: "stashpaper-modal-desc",
    });

    // ── SECTION 1: Add Tags ──
    contentEl.createDiv({
      cls: "stashpaper-tags-section-title",
      text: "Add tags to all selected articles:",
    });

    const addWrapper = contentEl.createDiv({
      cls: "stashpaper-control-wrapper",
    });

    const addTagsBox = addWrapper.createDiv({
      cls: "stashpaper-tags-box",
    });

    const addPillsContainer = addTagsBox.createDiv({
      cls: "stashpaper-pills-container",
      attr: { style: "display: contents;" },
    });

    const addInput = addTagsBox.createEl("input", {
      type: "text",
      cls: "stashpaper-tag-input",
      placeholder: "Type a tag to add…",
    });

    const addSuggesterEl = addWrapper.createDiv({
      cls: "stashpaper-suggester",
    });
    addSuggesterEl.hide();

    let highlightedIndex = -1;
    let currentOptions: string[] = [];

    const renderAddPills = () => {
      addPillsContainer.empty();
      for (const tag of this.tagsToAdd) {
        const pill = addPillsContainer.createSpan({
          cls: "stashpaper-tag-pill",
          text: `+ #${tag}`,
        });

        const removeBtn = pill.createEl("button", {
          cls: "stashpaper-tag-remove",
          text: "✕",
        });

        removeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.tagsToAdd = this.tagsToAdd.filter((t) => t !== tag);
          renderAddPills();
        });
      }
    };

    const addTagToAdd = (raw: string) => {
      const clean = raw.trim().replace(/^#+/, "").trim();
      if (!clean) return;
      if (!this.tagsToAdd.includes(clean)) {
        this.tagsToAdd.push(clean);
        renderAddPills();
      }
      addInput.value = "";
      addSuggesterEl.hide();
    };

    const renderAddSuggestions = (query: string) => {
      addSuggesterEl.empty();
      const allTags = this.getVaultTags();
      const cleanQ = query.trim().toLowerCase().replace(/^#+/, "");

      currentOptions = allTags.filter(
        (t) => t.toLowerCase().includes(cleanQ) && !this.tagsToAdd.includes(t)
      );

      if (cleanQ && !allTags.some((t) => t.toLowerCase() === cleanQ)) {
        currentOptions.unshift(cleanQ);
      }

      if (currentOptions.length === 0) {
        addSuggesterEl.hide();
        return;
      }

      currentOptions.forEach((opt, idx) => {
        const item = addSuggesterEl.createDiv({
          cls: `stashpaper-suggester-item ${idx === highlightedIndex ? "is-selected" : ""}`,
        });
        item.createSpan({ text: "# ", cls: "suggester-icon" });
        item.createSpan({ text: opt });
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          addTagToAdd(opt);
        });
      });

      addSuggesterEl.show();
    };

    addTagsBox.addEventListener("click", () => addInput.focus());

    addInput.addEventListener("focus", () => {
      highlightedIndex = -1;
      renderAddSuggestions(addInput.value);
    });

    addInput.addEventListener("input", () => {
      highlightedIndex = -1;
      renderAddSuggestions(addInput.value);
    });

    const outsideListener = (e: MouseEvent) => {
      if (!addWrapper.contains(e.target as Node)) {
        addSuggesterEl.hide();
        if (addInput.value.trim()) {
          addTagToAdd(addInput.value.trim());
        }
      }
    };
    document.addEventListener("pointerdown", outsideListener);

    addInput.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " " || e.key === ",") {
        e.preventDefault();
        if (addSuggesterEl.isShown() && highlightedIndex >= 0 && currentOptions[highlightedIndex]) {
          addTagToAdd(currentOptions[highlightedIndex]);
        } else if (addInput.value.trim()) {
          addTagToAdd(addInput.value.trim());
        }
        return;
      }

      if (e.key === "Backspace" && !addInput.value && this.tagsToAdd.length > 0) {
        this.tagsToAdd.pop();
        renderAddPills();
        return;
      }

      if (addSuggesterEl.isShown()) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          highlightedIndex = Math.min(highlightedIndex + 1, currentOptions.length - 1);
          renderAddSuggestions(addInput.value);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          highlightedIndex = Math.max(highlightedIndex - 1, 0);
          renderAddSuggestions(addInput.value);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          addSuggesterEl.hide();
          return;
        }
      }
    });

    // ── SECTION 2: Remove Tags ──
    contentEl.createDiv({
      cls: "stashpaper-tags-section-title",
      text: "Remove tags from selected articles (click to toggle removal):",
    });

    const removeContainer = contentEl.createDiv({
      cls: "stashpaper-remove-tags-container",
      attr: { style: "display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px;" },
    });

    if (this.allExistingTags.size === 0) {
      removeContainer.createSpan({
        text: "No existing tags on the selected articles.",
        cls: "stashpaper-modal-desc",
      });
    } else {
      const sortedExisting = Array.from(this.allExistingTags).sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: "base" })
      );

      for (const tag of sortedExisting) {
        const pill = removeContainer.createSpan({
          cls: `stashpaper-tag-pill is-removable ${this.tagsToRemove.has(tag) ? "is-marked-remove" : ""}`,
          text: `#${tag}`,
        });

        pill.addEventListener("click", () => {
          if (this.tagsToRemove.has(tag)) {
            this.tagsToRemove.delete(tag);
            pill.removeClass("is-marked-remove");
          } else {
            this.tagsToRemove.add(tag);
            pill.addClass("is-marked-remove");
          }
        });
      }
    }

    // Button Row
    const btnRow = contentEl.createDiv({
      cls: "stashpaper-modal-btn-row",
    });

    const cancelBtn = new ButtonComponent(btnRow)
      .setButtonText("Cancel")
      .onClick(() => {
        document.removeEventListener("pointerdown", outsideListener);
        this.close();
      });

    const applyBtn = new ButtonComponent(btnRow)
      .setButtonText("Apply changes")
      .setCta()
      .onClick(async () => {
        document.removeEventListener("pointerdown", outsideListener);
        if (addInput.value.trim()) {
          addTagToAdd(addInput.value.trim());
        }
        applyBtn.setDisabled(true);
        cancelBtn.setDisabled(true);

        for (const art of this.articles) {
          await this.app.fileManager.processFrontMatter(art.file, (fm) => {
            let tags = normalizeTags(fm.tags);
            // Remove marked tags
            tags = tags.filter((t) => !this.tagsToRemove.has(t));
            // Add new tags
            for (const addT of this.tagsToAdd) {
              if (!tags.includes(addT)) {
                tags.push(addT);
              }
            }
            fm.tags = tags;
          });

          // Update in-memory item
          let inMemory = normalizeTags(art.tags);
          inMemory = inMemory.filter((t) => !this.tagsToRemove.has(t));
          for (const addT of this.tagsToAdd) {
            if (!inMemory.includes(addT)) inMemory.push(addT);
          }
          art.tags = inMemory;
        }

        new Notice(`Updated tags across ${this.articles.length} articles`);
        this.close();
        await this.onDone();
      });
  }
}

/**
 * Confirmation dialog for single or bulk article deletion.
 */
export class ConfirmDeleteModal extends Modal {
  private articles: StashpaperArticleItem[];
  private onConfirm: () => Promise<void> | void;

  constructor(
    app: App,
    articles: StashpaperArticleItem[],
    onConfirm: () => Promise<void> | void
  ) {
    super(app);
    this.articles = articles;
    this.onConfirm = onConfirm;
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    modalEl.addClass("stashpaper-modal");
    contentEl.empty();

    const isSingle = this.articles.length === 1;
    this.titleEl.setText(isSingle ? "Delete article" : "Delete articles");

    const message = isSingle
      ? `Delete '${this.articles[0].title}'? This cannot be undone.`
      : `Delete ${this.articles.length} articles? This cannot be undone.`;

    contentEl.createEl("p", {
      text: message,
      cls: "stashpaper-modal-desc",
      attr: { style: "font-size: 14px; margin: 12px 0 20px 0; color: var(--text-normal);" },
    });

    const btnRow = contentEl.createDiv({
      cls: "stashpaper-modal-btn-row",
    });

    const cancelBtn = new ButtonComponent(btnRow)
      .setButtonText("Cancel")
      .onClick(() => this.close());

    const deleteBtn = new ButtonComponent(btnRow)
      .setButtonText(isSingle ? "Delete article" : `Delete ${this.articles.length} articles`)
      .setWarning()
      .onClick(async () => {
        deleteBtn.setDisabled(true);
        cancelBtn.setDisabled(true);
        try {
          await this.onConfirm();
          this.close();
        } catch (err) {
          deleteBtn.setDisabled(false);
          cancelBtn.setDisabled(false);
          console.error("Stashpaper: delete error", err);
        }
      });
  }
}
