import { Notice, Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { STASHPAPER_EXPLORER_VIEW, StashpaperExplorerView } from "./explorerView";
import { fetchAndParseArticle, stripMarkdownImages } from "./fetcher";
import { SaveArticleModal } from "./modal";
import { writeArticleNote } from "./noteWriter";
import { ReadingProgressTracker } from "./progressTracker";
import {
  DEFAULT_SETTINGS,
  StashpaperSettingTab,
  type StashpaperSettings,
} from "./settings";

// ── Dev-only test URL ─────────────────────────────────────────────────────────
// Swap this constant to test different sites, then run `npm run build`.
const TEST_ARTICLE_URL = "https://overreacted.io/before-you-memo/";
// ─────────────────────────────────────────────────────────────────────────────

export default class StashpaperPlugin extends Plugin {
  settings: StashpaperSettings;
  private progressTracker: ReadingProgressTracker | null = null;
  private statusBarEl: HTMLElement | null = null;

  async onload() {
    console.log("Stashpaper loaded");

    // 1. Load settings
    await this.loadSettings();

    // 2. Ensure initial default folders ("Stashpaper" and "Stashpaper/Inbox") exist
    await this.ensureDefaultFolders();

    // 3. Register settings tab
    this.addSettingTab(new StashpaperSettingTab(this.app, this));

    // 4. Register dedicated sidebar Explorer View
    this.registerView(
      STASHPAPER_EXPLORER_VIEW,
      (leaf) => new StashpaperExplorerView(leaf, this)
    );

    new Notice("Stashpaper loaded");

    // ------------------------------------------------------------------
    // Ribbon icon: one-tap access on mobile toolbar & desktop ribbon
    // ------------------------------------------------------------------
    this.addRibbonIcon("bookmark", "Stashpaper: Save article", () => {
      this.openSaveModal();
    });

    this.addRibbonIcon("book-open", "Stashpaper: Open reading list", () => {
      this.activateExplorerView();
    });

    // ------------------------------------------------------------------
    // Command: Save article
    // Opens the modal, then fetches + writes the note on submit.
    // ------------------------------------------------------------------
    this.addCommand({
      id: "stashpaper-save-article",
      name: "Stashpaper: Save article",
      callback: () => {
        this.openSaveModal();
      },
    });

    // ------------------------------------------------------------------
    // Command: Open reading list
    // Opens or focuses the Stashpaper Explorer view in the right sidebar.
    // ------------------------------------------------------------------
    this.addCommand({
      id: "stashpaper-open-reading-list",
      name: "Stashpaper: Open reading list",
      callback: () => {
        this.activateExplorerView();
      },
    });

    // ------------------------------------------------------------------
    // Command: Test fetch (dev only) — remove before release
    // ------------------------------------------------------------------
    this.addCommand({
      id: "stashpaper-test-fetch",
      name: "Stashpaper: Test fetch (dev only)",
      callback: async () => {
        try {
          const parsed = await fetchAndParseArticle(TEST_ARTICLE_URL);
          console.log("Stashpaper fetch test result:", parsed);
          new Notice("Stashpaper fetch test completed — check console");
        } catch (e) {
          console.error(e);
          new Notice("Stashpaper fetch test failed — check console");
        }
      },
    });

    // ------------------------------------------------------------------
    // Command: Re-fetch article
    // ------------------------------------------------------------------
    this.addCommand({
      id: "stashpaper-refetch-article",
      name: "Stashpaper: Re-fetch this article",
      checkCallback: (checking: boolean) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        const cache = this.app.metadataCache.getFileCache(file);
        if (!cache?.frontmatter?.source_url) return false;
        if (!checking) {
          this.refetchArticle(file);
        }
        return true;
      },
    });

    // ------------------------------------------------------------------
    // Reading progress tracking: status bar + scroll listener
    // ------------------------------------------------------------------
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.style.display = "none";
    this.statusBarEl.addClass("stashpaper-status-bar");

    this.progressTracker = new ReadingProgressTracker(this.app, this.statusBarEl);

    // Initial check when Obsidian layout is ready
    this.app.workspace.onLayoutReady(() => {
      this.progressTracker?.checkActiveNote();
    });

    // Fire on every leaf activation (tab/pane switch)
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.progressTracker?.checkActiveNote();
      })
    );

    // Fire when view mode toggles (source ↔ reading)
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.progressTracker?.checkActiveNote();
      })
    );

    // Also check when metadata cache resolves for files
    this.registerEvent(
      this.app.metadataCache.on("resolve", () => {
        this.progressTracker?.checkActiveNote();
      })
    );
  }

  /**
   * Opens or reveals the Stashpaper Explorer sidebar view.
   * If already open, focuses existing leaf rather than creating a duplicate.
   */
  async activateExplorerView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(STASHPAPER_EXPLORER_VIEW);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({
          type: STASHPAPER_EXPLORER_VIEW,
          active: true,
        });
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  /**
   * Opens the Save Article modal with full fetch and note creation flow.
   */
  openSaveModal(): void {
    new SaveArticleModal(this.app, this, async ({ url, folder, tags, notebook }) => {
      const progressNotice = new Notice("Stashpaper: fetching article…", 0);

      try {
        // 1. Fetch and parse (respecting keepImages setting)
        const article = await fetchAndParseArticle(url, {
          keepImages: this.settings.keepImages,
        });

        // 2. Write note to vault (ensureFolder inside creates any missing folders)
        const file = await writeArticleNote(
          this.app,
          article,
          folder,
          tags,
          { keepImages: this.settings.keepImages, notebook }
        );

        // 3. Open the newly created note in Reading View
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(file, { state: { mode: "preview" } });

        progressNotice.hide();
        new Notice(`Article saved: ${article.title}`);
      } catch (e: unknown) {
        progressNotice.hide();
        const raw = e instanceof Error ? e.message : String(e);
        const message = raw.split("\n")[0].replace(/^Error:\s*/, "");
        console.error("Stashpaper: save failed", e);
        new Notice(`Stashpaper: failed to save article — ${message}`, 8000);
        throw e;
      }
    }).open();
  }

  /**
   * Re-fetches the article for a specific note from its frontmatter source_url,
   * refreshing content and reading time while preserving existing metadata.
   */
  async refetchArticle(file: TFile): Promise<void> {
    const cache = this.app.metadataCache.getFileCache(file);
    const sourceUrl = cache?.frontmatter?.source_url;
    if (!sourceUrl || typeof sourceUrl !== "string") {
      new Notice("Stashpaper: note has no source_url in frontmatter");
      return;
    }

    const progressNotice = new Notice("Stashpaper: re-fetching article…", 0);
    try {
      const article = await fetchAndParseArticle(sourceUrl, {
        keepImages: this.settings.keepImages,
      });

      const bodyMarkdown =
        this.settings.keepImages === false
          ? stripMarkdownImages(article.markdown)
          : article.markdown;

      const wordCount = bodyMarkdown.trim().split(/\s+/).length;
      const readingTimeMinutes = Math.max(1, Math.round(wordCount / 200));

      const rawContent = await this.app.vault.read(file);
      const fmMatch = rawContent.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);

      if (fmMatch) {
        await this.app.fileManager.processFrontMatter(file, (fm) => {
          if (article.title) fm.title = article.title;
          if (article.byline) fm.author = article.byline;
          fm.reading_time_minutes = readingTimeMinutes;
        });

        const updated = await this.app.vault.read(file);
        const newFmMatch = updated.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
        const fmBlock = newFmMatch ? newFmMatch[0] : "---\n---\n";
        const newContent = `${fmBlock.trimEnd()}\n\n${bodyMarkdown}\n`;
        await this.app.vault.modify(file, newContent);
      } else {
        const newContent = `${bodyMarkdown}\n`;
        await this.app.vault.modify(file, newContent);
      }

      progressNotice.hide();
      new Notice(`Article re-fetched: ${article.title}`);
    } catch (e: unknown) {
      progressNotice.hide();
      const raw = e instanceof Error ? e.message : String(e);
      const message = raw.split("\n")[0].replace(/^Error:\s*/, "");
      console.error("Stashpaper: re-fetch failed", e);
      new Notice(`Stashpaper: failed to re-fetch — ${message}`, 8000);
      throw e;
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async addSavedTag(tag: string) {
    const clean = tag.trim().replace(/^#+/, "").trim();
    if (!clean) return;
    if (!this.settings.savedTags) {
      this.settings.savedTags = [];
    }
    if (!this.settings.savedTags.includes(clean)) {
      this.settings.savedTags.push(clean);
      await this.saveSettings();
    }
  }

  /**
   * Ensures the root folder and default inbox folder exist in the vault.
   */
  async ensureDefaultFolders() {
    try {
      const root = this.settings.rootFolder || "Stashpaper";
      const inbox = this.settings.defaultFolder || `${root}/Inbox`;

      const createPath = async (folderPath: string) => {
        const parts = folderPath.split("/").filter(Boolean);
        let current = "";
        for (const part of parts) {
          current = current ? `${current}/${part}` : part;
          if (!this.app.vault.getFolderByPath(current)) {
            await this.app.vault.createFolder(current);
          }
        }
      };

      await createPath(root);
      await createPath(inbox);
    } catch (err) {
      // In case the folders already exist concurrently or on initial sync
      console.debug("Stashpaper: default folder init note", err);
    }
  }

  onunload() {
    console.log("Stashpaper unloaded");
    this.progressTracker?.destroy();
    this.app.workspace.detachLeavesOfType(STASHPAPER_EXPLORER_VIEW);
    new Notice("Stashpaper unloaded");
  }
}
