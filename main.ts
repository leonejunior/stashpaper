import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { STASHPAPER_EXPLORER_VIEW, StashpaperExplorerView } from "./explorerView";
import { fetchAndParseArticle } from "./fetcher";
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
    // Reading progress tracking: status bar + scroll listener
    // ------------------------------------------------------------------
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.style.display = "none";
    this.statusBarEl.addClass("stashpaper-status-bar");

    this.progressTracker = new ReadingProgressTracker(this.app, this.statusBarEl);

    // Fire on every leaf activation (tab/pane switch)
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        this.progressTracker?.onActiveLeafChange(leaf);
      })
    );

    // Fire when view mode toggles (source ↔ reading)
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.progressTracker?.onLayoutChange();
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
    new SaveArticleModal(this.app, this, async ({ url, folder, tags }) => {
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
          { keepImages: this.settings.keepImages }
        );

        // 3. Open the newly created note in the active pane
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(file);

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
