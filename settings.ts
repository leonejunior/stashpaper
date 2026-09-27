import { App, PluginSettingTab, Setting } from "obsidian";
import type StashpaperPlugin from "./main";

export interface StashpaperSettings {
  defaultFolder: string;
  keepImages: boolean;
  rootFolder: string;
  savedTags: string[];
}

export const DEFAULT_SETTINGS: StashpaperSettings = {
  defaultFolder: "Stashpaper/Inbox",
  keepImages: true,
  rootFolder: "Stashpaper",
  savedTags: [],
};

/**
 * Parses a user-entered folder setting into a root folder and default inbox path.
 * If user enters "Articles", root is "Articles" and defaultFolder is "Articles/Inbox".
 * If user enters "Stashpaper1/Inbox", root is "Stashpaper1" and defaultFolder is "Stashpaper1/Inbox".
 */
export function parseRootAndInbox(input: string): {
  rootFolder: string;
  defaultFolder: string;
} {
  const clean = input.trim().replace(/^\/+|\/+$/g, "");
  if (!clean) {
    return { rootFolder: "Stashpaper", defaultFolder: "Stashpaper/Inbox" };
  }

  if (clean.toLowerCase().endsWith("/inbox")) {
    const root = clean.slice(0, -"/inbox".length).trim().replace(/\/+$/, "") || "Stashpaper";
    return { rootFolder: root, defaultFolder: `${root}/Inbox` };
  }

  return { rootFolder: clean, defaultFolder: `${clean}/Inbox` };
}

export class StashpaperSettingTab extends PluginSettingTab {
  plugin: StashpaperPlugin;

  constructor(app: App, plugin: StashpaperPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Stashpaper Settings" });

    new Setting(containerEl)
      .setName("Default save folder")
      .setDesc(
        "The root or default folder inside your vault (e.g. Stashpaper/Inbox or Articles). An Inbox subfolder will be used/created for unsorted articles."
      )
      .addText((text) =>
        text
          .setPlaceholder("Stashpaper/Inbox")
          .setValue(this.plugin.settings.defaultFolder)
          .onChange(async (value) => {
            const parsed = parseRootAndInbox(value);
            this.plugin.settings.rootFolder = parsed.rootFolder;
            this.plugin.settings.defaultFolder = parsed.defaultFolder;
            await this.plugin.saveSettings();
            await this.plugin.ensureDefaultFolders();
          })
      );

    new Setting(containerEl)
      .setName("Keep images as remote links")
      .setDesc(
        "When enabled, images in articles will remain as remote web links. When disabled, images are stripped from saved articles."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.keepImages ?? true)
          .onChange(async (value) => {
            this.plugin.settings.keepImages = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
