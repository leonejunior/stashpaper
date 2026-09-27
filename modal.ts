import { App, ButtonComponent, Modal, Platform, Setting } from "obsidian";
import type StashpaperPlugin from "./main";

/** The data collected and returned by the modal on submit. */
export interface SaveArticleData {
  url: string;
  folder: string;
  tags: string[];
}

const URL_PATTERN = /^https?:\/\/.+/i;

/**
 * Modal that collects:
 * 1. Article URL (pre-filled from clipboard if valid)
 * 2. Destination folder with interactive search & creation
 * 3. Tags with tag pills (✕ to remove) and auto-suggest from vault + saved tags
 */
export class SaveArticleModal extends Modal {
  private url = "";
  private subFolder = "Inbox";
  private selectedTags: string[] = [];

  private plugin: StashpaperPlugin;
  private readonly onSubmit: (data: SaveArticleData) => Promise<void> | void;
  private documentListeners: Array<() => void> = [];

  constructor(
    app: App,
    plugin: StashpaperPlugin,
    onSubmit: (data: SaveArticleData) => Promise<void> | void
  ) {
    super(app);
    this.plugin = plugin;
    this.onSubmit = onSubmit;
    this.subFolder = "Inbox";
  }

  async onOpen(): Promise<void> {
    const { contentEl, modalEl } = this;
    modalEl.addClass("stashpaper-modal");
    contentEl.empty();

    this.titleEl.setText("Save article to vault");

    // ------------------------------------------------------------------
    // Mobile Viewport Tracker: Keeps dialog sized above virtual keyboard
    // ------------------------------------------------------------------
    if (Platform.isMobile) {
      const handleViewportResize = () => {
        const vp = window.visualViewport;
        const availableHeight = vp ? vp.height : window.innerHeight;
        modalEl.style.maxHeight = `${Math.floor(availableHeight - 16)}px`;
      };

      handleViewportResize();

      if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", handleViewportResize);
        window.visualViewport.addEventListener("scroll", handleViewportResize);
        this.documentListeners.push(() => {
          window.visualViewport?.removeEventListener("resize", handleViewportResize);
          window.visualViewport?.removeEventListener("scroll", handleViewportResize);
        });
      } else {
        window.addEventListener("resize", handleViewportResize);
        this.documentListeners.push(() => {
          window.removeEventListener("resize", handleViewportResize);
        });
      }
    }

    // ------------------------------------------------------------------
    // 1. Pre-fill URL from clipboard if it looks like a valid URL
    // ------------------------------------------------------------------
    try {
      const clip = await navigator.clipboard.readText();
      if (URL_PATTERN.test(clip.trim())) {
        this.url = clip.trim();
      }
    } catch {
      // Clipboard access not available — proceed with empty default
    }

    // ------------------------------------------------------------------
    // 2. URL field
    // ------------------------------------------------------------------
    let urlErrorEl: HTMLElement | null = null;
    const urlSetting = new Setting(contentEl)
      .setName("Article URL")
      .setDesc("Paste or type the URL of the article you want to save.")
      .addText((text) => {
        text
          .setPlaceholder("https://example.com/article")
          .setValue(this.url)
          .onChange((value) => {
            this.url = value.trim();
            if (urlErrorEl && URL_PATTERN.test(this.url)) {
              urlErrorEl.setText("");
            }
          });
        text.inputEl.style.width = "100%";
        if (Platform.isMobile) {
          text.inputEl.addEventListener("focus", () => {
            setTimeout(() => {
              text.inputEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
            }, 120);
          });
        }
        setTimeout(() => text.inputEl.focus(), 50);
      });

    urlErrorEl = urlSetting.controlEl.createDiv({
      cls: "stashpaper-error-msg",
    });

    // ------------------------------------------------------------------
    // 3. Folder Selector with Autocomplete & Creation
    // ------------------------------------------------------------------
    this.createFolderPickerSetting(contentEl);

    // ------------------------------------------------------------------
    // 4. Tags Selector with Pills & Autocomplete
    // ------------------------------------------------------------------
    this.createTagsPickerSetting(contentEl);

    // ------------------------------------------------------------------
    // 5. Save / Cancel buttons with loading state & double-submit protection
    // ------------------------------------------------------------------
    let isSaving = false;
    let saveBtnRef: ButtonComponent | null = null;
    let cancelBtnRef: ButtonComponent | null = null;

    const buttonSetting = new Setting(contentEl);
    buttonSetting.infoEl.remove(); // Spacer so buttons sit on the right
    buttonSetting.setClass("stashpaper-button-container");

    buttonSetting
      .addButton((btn) => {
        cancelBtnRef = btn;
        btn.setButtonText("Cancel").onClick(() => {
          if (!isSaving) {
            this.close();
          }
        });
      })
      .addButton((btn) => {
        saveBtnRef = btn;
        btn
          .setButtonText("Save")
          .setCta()
          .onClick(async () => {
            if (isSaving) return;

            if (!URL_PATTERN.test(this.url)) {
              if (urlErrorEl) {
                urlErrorEl.setText("Please enter a valid URL starting with http:// or https://");
              }
              return;
            }

            // Enter loading state
            isSaving = true;
            saveBtnRef?.setDisabled(true);
            saveBtnRef?.setButtonText("Saving…");
            cancelBtnRef?.setDisabled(true);
            if (urlErrorEl) urlErrorEl.setText("");

            const root = this.plugin.settings?.rootFolder || "Stashpaper";
            const escapedRoot = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const cleanSub = this.subFolder
              .replace(new RegExp(`^${escapedRoot}[\\/]?`, "i"), "")
              .replace(/^\/+|\/+$/g, "")
              .trim();

            // If empty, save standalone directly in the root folder!
            const targetFolder = cleanSub ? `${root}/${cleanSub}` : root;

            try {
              await this.onSubmit({
                url: this.url,
                folder: targetFolder,
                tags: [...this.selectedTags],
              });
              this.close();
            } catch (err: unknown) {
              // On failure: re-enable buttons so user can fix and retry
              isSaving = false;
              saveBtnRef?.setDisabled(false);
              saveBtnRef?.setButtonText("Save");
              cancelBtnRef?.setDisabled(false);

              const raw = err instanceof Error ? err.message : String(err);
              const cleanMsg = raw.split("\n")[0].replace(/^Error:\s*/, "");
              if (urlErrorEl) {
                urlErrorEl.setText(`⚠ ${cleanMsg}`);
              }
            }
          });
      });
  }

  /**
   * Builds the Folder picker with dropdown suggestions, root badge in title,
   * nested folder slash navigation, and standalone root support.
   */
  private createFolderPickerSetting(containerEl: HTMLElement): void {
    const root = this.plugin.settings?.rootFolder || "Stashpaper";
    const escapedRoot = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const folderSetting = new Setting(containerEl);

    // Header label with styled root badge matching screenshot 3
    folderSetting.nameEl.empty();
    folderSetting.nameEl.createSpan({ text: "Save to folder: " });
    folderSetting.nameEl.createSpan({
      cls: "stashpaper-root-badge",
      text: `/${root}`,
    });

    folderSetting.setDesc(
      `Folder inside /${root}. Leave empty to save directly in /${root}.`
    );

    const wrapper = folderSetting.controlEl.createDiv({
      cls: "stashpaper-control-wrapper stashpaper-folder-wrapper",
    });

    const input = wrapper.createEl("input", {
      type: "text",
      cls: "stashpaper-folder-input",
      value: this.subFolder,
      placeholder: `e.g. Inbox (leave empty for /${root})`,
    });

    const suggesterEl = wrapper.createDiv({
      cls: "stashpaper-suggester",
    });
    suggesterEl.hide();

    let highlightedIndex = -1;
    let currentOptions: string[] = [];

    const getSubFolders = (): string[] => {
      const prefix = `${root.toLowerCase()}/`;
      const allFolders = this.app.vault.getAllFolders(false).map((f) => f.path);

      const list = new Set<string>();
      list.add("Inbox");

      allFolders.forEach((folderPath) => {
        if (folderPath.toLowerCase().startsWith(prefix)) {
          const sub = folderPath.slice(root.length + 1).trim();
          if (sub) {
            list.add(sub);
          }
        }
      });

      return Array.from(list).sort((a, b) => {
        if (a.toLowerCase() === "inbox") return -1;
        if (b.toLowerCase() === "inbox") return 1;
        return a.localeCompare(b);
      });
    };

    const renderFolderSuggestions = (rawQuery: string) => {
      suggesterEl.empty();
      const allSubFolders = getSubFolders();

      // Clean query: strip root prefix and leading slashes, keep trailing slash
      const cleanQuery = rawQuery
        .replace(new RegExp(`^${escapedRoot}[\\/]?`, "i"), "")
        .replace(/^\/+/, "");

      currentOptions = [];

      // ── CASE 1: Query is completely empty ───────────────────────
      if (!cleanQuery) {
        // Option to save standalone in root
        currentOptions.push("__ROOT__");
        const rootItem = suggesterEl.createDiv({
          cls: `stashpaper-suggester-item ${highlightedIndex === 0 ? "is-selected" : ""}`,
        });
        rootItem.createSpan({ text: "📂 ", cls: "suggester-icon" });
        rootItem.createSpan({ text: `/${root} (standalone in root)` });
        rootItem.addEventListener("mousedown", (e) => {
          e.preventDefault();
          selectFolder("__ROOT__");
        });

        // Top-level subfolders
        allSubFolders.forEach((subName, idx) => {
          const optIdx = idx + 1;
          const hasChildren = allSubFolders.some(
            (f) => f.toLowerCase().startsWith(subName.toLowerCase() + "/")
          );
          currentOptions.push(subName);

          const itemEl = suggesterEl.createDiv({
            cls: `stashpaper-suggester-item ${optIdx === highlightedIndex ? "is-selected" : ""}`,
          });
          itemEl.createSpan({ text: "📁 ", cls: "suggester-icon" });
          itemEl.createSpan({ text: hasChildren ? `${subName}/` : subName });

          itemEl.addEventListener("mousedown", (e) => {
            e.preventDefault();
            selectFolder(subName);
          });
        });

        suggesterEl.show();
        return;
      }

      // ── CASE 2: Query ends with a slash (user is drilling into a subfolder)
      if (cleanQuery.endsWith("/")) {
        const parentPath = cleanQuery.slice(0, -1);
        const parentLower = parentPath.toLowerCase();

        // Option 1: save directly in this parent folder
        currentOptions.push(parentPath);
        const parentItem = suggesterEl.createDiv({
          cls: `stashpaper-suggester-item ${highlightedIndex === 0 ? "is-selected" : ""}`,
        });
        parentItem.createSpan({ text: "📁 ", cls: "suggester-icon" });
        parentItem.createSpan({ text: `Save directly in "${parentPath}"` });
        parentItem.addEventListener("mousedown", (e) => {
          e.preventDefault();
          selectFolder(parentPath, false);
        });

        // Child folders that start with parentPath/
        const childMatches = allSubFolders.filter((f) =>
          f.toLowerCase().startsWith(`${parentLower}/`)
        );

        childMatches.forEach((childPath) => {
          currentOptions.push(childPath);
          const hasMoreChildren = allSubFolders.some(
            (f) => f.toLowerCase().startsWith(childPath.toLowerCase() + "/")
          );
          const itemEl = suggesterEl.createDiv({
            cls: `stashpaper-suggester-item ${currentOptions.length - 1 === highlightedIndex ? "is-selected" : ""}`,
          });
          itemEl.createSpan({ text: "📁 ", cls: "suggester-icon" });
          itemEl.createSpan({
            text: hasMoreChildren ? `${childPath}/` : childPath,
          });

          itemEl.addEventListener("mousedown", (e) => {
            e.preventDefault();
            selectFolder(childPath);
          });
        });

        suggesterEl.show();
        return;
      }

      // ── CASE 3: Query has text (filtering or typing new folder name)
      const q = cleanQuery.toLowerCase();
      const matches = allSubFolders.filter((f) =>
        f.toLowerCase().includes(q)
      );

      matches.forEach((subName) => {
        currentOptions.push(subName);
        const hasChildren = allSubFolders.some(
          (f) => f.toLowerCase().startsWith(subName.toLowerCase() + "/")
        );
        const itemEl = suggesterEl.createDiv({
          cls: `stashpaper-suggester-item ${currentOptions.length - 1 === highlightedIndex ? "is-selected" : ""}`,
        });
        itemEl.createSpan({ text: "📁 ", cls: "suggester-icon" });
        itemEl.createSpan({ text: hasChildren ? `${subName}/` : subName });

        itemEl.addEventListener("mousedown", (e) => {
          e.preventDefault();
          selectFolder(subName);
        });
      });

      const hasExactMatch = allSubFolders.some(
        (f) => f.toLowerCase() === q
      );

      if (!hasExactMatch && cleanQuery.trim()) {
        const createCandidate = cleanQuery.trim().replace(/\/+$/, "");
        currentOptions.push(createCandidate);

        const createEl = suggesterEl.createDiv({
          cls: `stashpaper-suggester-item is-create ${currentOptions.length - 1 === highlightedIndex ? "is-selected" : ""}`,
        });
        createEl.createSpan({ text: "➕ ", cls: "suggester-icon" });
        createEl.createSpan({ text: `Create folder: "${createCandidate}"` });

        createEl.addEventListener("mousedown", (e) => {
          e.preventDefault();
          selectFolder(createCandidate, false);
        });
      }

      if (currentOptions.length === 0) {
        suggesterEl.createDiv({
          text: "No matching folders",
          cls: "stashpaper-suggester-empty",
        });
      }

      suggesterEl.show();
    };

    const selectFolder = (subPath: string, canDrillDown = true) => {
      if (subPath === "__ROOT__") {
        this.subFolder = "";
        input.value = "";
        suggesterEl.hide();
        highlightedIndex = -1;
        return;
      }

      const allSubFolders = getSubFolders();
      const clean = subPath.replace(/\/+$/, "");
      const hasChildren = allSubFolders.some(
        (f) => f.toLowerCase().startsWith(`${clean.toLowerCase()}/`)
      );

      if (hasChildren && canDrillDown) {
        // Add a forward slash and display the nested folders inside it
        const withSlash = `${clean}/`;
        this.subFolder = withSlash;
        input.value = withSlash;
        highlightedIndex = -1;
        renderFolderSuggestions(withSlash);
      } else {
        this.subFolder = clean;
        input.value = clean;
        suggesterEl.hide();
        highlightedIndex = -1;
      }
    };

    const scrollFolderIntoView = () => {
      if (Platform.isMobile) {
        setTimeout(() => {
          input.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }, 120);
      }
    };

    input.addEventListener("focus", () => {
      highlightedIndex = -1;
      renderFolderSuggestions(input.value);
      scrollFolderIntoView();
    });

    input.addEventListener("click", () => {
      highlightedIndex = -1;
      renderFolderSuggestions(input.value);
      scrollFolderIntoView();
    });

    input.addEventListener("input", () => {
      const clean = input.value
        .replace(new RegExp(`^${escapedRoot}[\\/]?`, "i"), "")
        .replace(/^\/+/, "");
      this.subFolder = clean;
      highlightedIndex = -1;
      renderFolderSuggestions(input.value);
      scrollFolderIntoView();
    });

    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (suggesterEl.isShown()) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          highlightedIndex = Math.min(
            highlightedIndex + 1,
            currentOptions.length - 1
          );
          renderFolderSuggestions(input.value);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          highlightedIndex = Math.max(highlightedIndex - 1, 0);
          renderFolderSuggestions(input.value);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          if (highlightedIndex >= 0 && currentOptions[highlightedIndex]) {
            e.preventDefault();
            selectFolder(currentOptions[highlightedIndex]);
            return;
          }
          if (input.value.trim()) {
            selectFolder(input.value.trim(), false);
          }
        }
        if (e.key === "Escape") {
          e.preventDefault();
          suggesterEl.hide();
        }
      }
    });

    // Dismiss on outside click (leave input empty if user emptied it!)
    const outsideListener = (e: MouseEvent) => {
      if (!wrapper.contains(e.target as Node)) {
        suggesterEl.hide();
      }
    };
    document.addEventListener("pointerdown", outsideListener);
    this.documentListeners.push(() => {
      document.removeEventListener("pointerdown", outsideListener);
    });
  }

  /**
   * Builds the Tags picker with pills (✕ close button) matching screenshot 3,
   * autocomplete from existing tags, and on-the-fly tag creation.
   */
  private createTagsPickerSetting(containerEl: HTMLElement): void {
    const tagsSetting = new Setting(containerEl)
      .setName("Tags")
      .setDesc("Add tags to categorize this article. Press Enter, Space, or select from suggestions.");

    const wrapper = tagsSetting.controlEl.createDiv({
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

    const getAvailableTags = (): string[] => {
      const vaultTags = new Set<string>();

      // 1. Try runtime getTags() on metadataCache
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

      // 2. Also check file caches from markdown files in vault
      const mdFiles = this.app.vault.getMarkdownFiles();
      for (const file of mdFiles) {
        const cache = this.app.metadataCache.getFileCache(file);
        if (cache?.tags) {
          for (const t of cache.tags) {
            const clean = t.tag.replace(/^#+/, "").trim();
            if (clean) vaultTags.add(clean);
          }
        }
        const fmTags = cache?.frontmatter?.tags;
        if (Array.isArray(fmTags)) {
          for (const t of fmTags) {
            if (typeof t === "string") {
              const clean = t.replace(/^#+/, "").trim();
              if (clean) vaultTags.add(clean);
            }
          }
        } else if (typeof fmTags === "string") {
          fmTags.split(",").forEach((t) => {
            const clean = t.replace(/^#+/, "").trim();
            if (clean) vaultTags.add(clean);
          });
        }
      }

      // 3. Include tags saved in Stashpaper plugin settings
      const savedTags = this.plugin.settings?.savedTags || [];
      savedTags.forEach((t) => {
        const clean = t.replace(/^#+/, "").trim();
        if (clean) vaultTags.add(clean);
      });

      // Exclude already selected tags and sort
      return Array.from(vaultTags)
        .filter((t) => t.length > 0 && !this.selectedTags.includes(t))
        .sort((a, b) => a.localeCompare(b));
    };

    const renderPills = () => {
      pillsContainer.empty();
      this.selectedTags.forEach((tag) => {
        const pill = pillsContainer.createSpan({
          cls: "stashpaper-tag-pill",
        });

        pill.createSpan({
          text: tag,
          cls: "stashpaper-tag-text",
        });

        const removeBtn = pill.createEl("button", {
          text: "✕",
          cls: "stashpaper-tag-remove",
          attr: { type: "button", "aria-label": `Remove tag ${tag}` },
        });

        removeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.selectedTags = this.selectedTags.filter((t) => t !== tag);
          renderPills();
          tagInput.focus();
        });
      });

      tagInput.placeholder = this.selectedTags.length > 0 ? "Add another tag..." : "Add tags (e.g. ai, tech)...";
    };

    const addTag = async (rawTag: string) => {
      const clean = rawTag.trim().replace(/^#+/, "").replace(/,/g, "").trim();
      if (!clean) return;

      if (!this.selectedTags.includes(clean)) {
        this.selectedTags.push(clean);
        // Persist new tag so it is available next time
        await this.plugin.addSavedTag(clean);
        renderPills();
      }

      tagInput.value = "";
      highlightedIndex = -1;
      renderTagSuggestions("");
    };

    const renderTagSuggestions = (query: string) => {
      suggesterEl.empty();
      const available = getAvailableTags();
      const q = query.trim().toLowerCase().replace(/^#/, "");

      const matches = available.filter((t) => t.toLowerCase().includes(q));
      currentOptions = [...matches];

      const cleanQuery = query.trim().replace(/^#+/, "").replace(/,/g, "").trim();
      const hasExactMatch = available.some((t) => t.toLowerCase() === cleanQuery.toLowerCase());
      const alreadySelected = this.selectedTags.some((t) => t.toLowerCase() === cleanQuery.toLowerCase());

      let canCreate = false;
      if (cleanQuery && !hasExactMatch && !alreadySelected) {
        canCreate = true;
        currentOptions.push(cleanQuery);
      }

      if (currentOptions.length === 0) {
        suggesterEl.createDiv({
          text: available.length === 0 ? "No existing tags in vault yet" : "No matching tags",
          cls: "stashpaper-suggester-empty",
        });
        suggesterEl.show();
        return;
      }

      matches.forEach((tag, idx) => {
        const itemEl = suggesterEl.createDiv({
          cls: `stashpaper-suggester-item ${idx === highlightedIndex ? "is-selected" : ""}`,
        });
        itemEl.createSpan({ text: "# ", cls: "suggester-icon" });
        itemEl.createSpan({ text: tag });

        itemEl.addEventListener("mousedown", (e) => {
          e.preventDefault();
          addTag(tag);
        });
      });

      if (canCreate) {
        const createEl = suggesterEl.createDiv({
          cls: `stashpaper-suggester-item is-create ${matches.length === highlightedIndex ? "is-selected" : ""}`,
        });
        createEl.createSpan({ text: "➕ ", cls: "suggester-icon" });
        createEl.createSpan({ text: `Create tag "#${cleanQuery}"` });

        createEl.addEventListener("mousedown", (e) => {
          e.preventDefault();
          addTag(cleanQuery);
        });
      }

      suggesterEl.show();
    };

    const scrollTagsIntoView = () => {
      if (Platform.isMobile) {
        setTimeout(() => {
          tagsBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }, 120);
      }
    };

    tagsBox.addEventListener("click", () => {
      tagInput.focus();
      scrollTagsIntoView();
    });

    tagInput.addEventListener("focus", () => {
      highlightedIndex = -1;
      renderTagSuggestions(tagInput.value);
      scrollTagsIntoView();
    });

    tagInput.addEventListener("click", () => {
      highlightedIndex = -1;
      renderTagSuggestions(tagInput.value);
      scrollTagsIntoView();
    });

    tagInput.addEventListener("input", () => {
      highlightedIndex = -1;
      renderTagSuggestions(tagInput.value);
      scrollTagsIntoView();
    });

    tagInput.addEventListener("keydown", async (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " " || e.key === ",") {
        e.preventDefault();
        if (suggesterEl.isShown() && highlightedIndex >= 0 && currentOptions[highlightedIndex]) {
          await addTag(currentOptions[highlightedIndex]);
        } else if (tagInput.value.trim()) {
          await addTag(tagInput.value.trim());
        }
        return;
      }

      if (e.key === "Backspace" && !tagInput.value && this.selectedTags.length > 0) {
        this.selectedTags.pop();
        renderPills();
        renderTagSuggestions("");
        return;
      }

      if (suggesterEl.isShown()) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          highlightedIndex = Math.min(highlightedIndex + 1, currentOptions.length - 1);
          renderTagSuggestions(tagInput.value);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          highlightedIndex = Math.max(highlightedIndex - 1, 0);
          renderTagSuggestions(tagInput.value);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          suggesterEl.hide();
        }
      }
    });

    const outsideListener = (e: MouseEvent) => {
      if (!wrapper.contains(e.target as Node)) {
        suggesterEl.hide();
        // If user left uncommitted tag in the input box, add it
        if (tagInput.value.trim()) {
          addTag(tagInput.value.trim());
        }
      }
    };
    document.addEventListener("pointerdown", outsideListener);
    this.documentListeners.push(() => {
      document.removeEventListener("pointerdown", outsideListener);
    });

    // Initial render
    renderPills();
  }

  onClose(): void {
    // Clean up document event listeners
    this.documentListeners.forEach((cleanup) => cleanup());
    this.documentListeners = [];
    this.contentEl.empty();
  }
}
