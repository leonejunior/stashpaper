# Stashpaper

**Stashpaper** is an Obsidian plugin to save, organize, and read web articles directly inside your vault. Powered by Mozilla's Readability engine, Turndown Markdown conversion, and Obsidian's cross-platform APIs.

## ✨ Features

- **Clean Article Extraction**: Strips ads, navigation, and clutter to extract clean article content, title, and bylines.
- **YAML Frontmatter**: Automatically tags each note with `title`, `source_url`, `author`, `date_saved`, `status: unread`, and your custom tags.
- **Smart Folder Routing**:
  - Dynamic root folder support with automatic `Inbox` creation for unsorted articles.
  - Drill-down subfolder navigation using forward slashes (`/`).
  - On-the-fly folder creation at any depth (e.g. `Research/2026/AI`).
  - Standalone save directly into the root folder when left empty.
- **Tag Management**:
  - Visual tag badges/pills with one-tap `✕` removal.
  - Autocomplete from your vault's existing tags and previously saved tags.
  - On-the-fly tag creation by pressing Enter, Space, or Comma.
- **Image Handling**: Toggle whether remote image links are retained or stripped completely.
- **Mobile First**: Fully optimized for Obsidian Mobile (Android & iOS) with bottom ribbon quick actions, touch-friendly tap targets, and soft keyboard viewport adaptation.
- **Hardened Error Boundaries**: Friendly notifications for network disconnections, DNS typos, HTTP 404/403, and automated duplicate note suffixing (`(2)`, `(3)`, etc.).

## 🚀 Installation

### Manual Installation
1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. In your Obsidian vault, navigate to `.obsidian/plugins/` (enable hidden files).
3. Create a folder named `stashpaper` and place the three files inside.
4. In Obsidian, go to **Settings → Community plugins** and toggle **Stashpaper** ON.

## 🛠️ Development

```bash
# Clone the repository
git clone https://github.com/leonejunior/stashpaper.git
cd stashpaper

# Install dependencies
npm install

# Build production bundle
npm run build

# Start development watch mode
npm run dev
```

## 📄 License

MIT
