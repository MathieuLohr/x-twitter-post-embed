# X/Twitter Post Embed

An Obsidian plugin that automatically embeds X (formerly Twitter) post text when you paste a URL. Also saves posts as individual notes via the command palette.

## Features

- **Auto-embed on paste** — paste a tweet URL and it's replaced with formatted text
- **Full thread support** — captures entire tweet threads, not just the first post
- **Multiple formats** — blockquote, callout, or plain text
- **Save as note** — save tweets as individual markdown files
- **Author pages** — automatically creates per-author aggregation pages with transclusion
- **Rich metadata** — optionally includes date, media, engagement metrics, community notes, and author bio
- **Translation** — fetch tweets in a chosen language via FxTwitter (defaults to English; blank to disable)
- **Quote tweet support** — nested formatting for quoted tweets
- **Parse existing links** — command to retroactively parse bare tweet URLs in a note

## Installation

### From Obsidian Community Plugins

1. Open Settings > Community Plugins
2. Search for "X/Twitter Post Embed"
3. Click Install, then Enable

### Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release
2. Create a folder `x-twitter-post-embed` in your vault's `.obsidian/plugins/` directory
3. Copy the downloaded files into that folder
4. Enable the plugin in Settings > Community Plugins

## Usage

**Paste a tweet URL** into any note — the plugin intercepts the paste and replaces the URL with the formatted tweet text.

**Save a tweet as a note** using the command palette (`Cmd/Ctrl+P`) > "Save X Post", or click the Twitter icon in the ribbon.

**Parse existing links** via the command palette > "Parse unparsed tweet links" to convert bare tweet URLs already in your notes.

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| Tweets folder | Where saved tweet notes are stored | `Tweets` |
| Author pages | Create per-author aggregation pages | Off |
| Paste format | Blockquote, callout, or plain | Blockquote |
| Auto-embed on paste | Automatically replace pasted URLs | On |
| Save on paste | Also save a note when pasting | Off |
| Include date | Show tweet date/time | On |
| Include media | Embed images from tweets | On |
| Include metrics | Show likes, reposts, etc. | Off |
| Include community notes | Show community notes | On |
| Include author bio | Show author description/followers | Off |
| Translate tweets to language | ISO code (e.g. `en`) for FxTwitter translation; blank disables | `en` |

## Network Usage

This plugin makes requests to external services to fetch tweet data. No user data is sent beyond the tweet ID being fetched.

| Service | Domain | Purpose |
|---------|--------|---------|
| [FxTwitter API](https://github.com/FixTweet/FxTwitter) | `api.fxtwitter.com` | Primary source for tweet text, threads, and metadata |
| Twitter oEmbed | `publish.twitter.com` | Fallback if FxTwitter is unavailable |

## Privacy & Permissions

This plugin only accesses what's needed for its features:

- **Vault files** — only markdown notes under your configured **Tweets folder** are read or modified, and only when you run the "Migrate tweet media" command.
- **Clipboard read** — only when you click the "Paste from clipboard" button in the tweet URL modal. Falls back to manual paste if blocked.
- **Clipboard write** — only when the "Copy path to clipboard" setting is enabled, and only after you save a tweet as a note (writes a wiki-link, nothing else).
- **Network** — see "Network Usage" above. No telemetry, no analytics.

## Credits

Inspired by [x-post-saver](https://github.com/tanaka-mambinge/x-post-saver) by [tanaka-mambinge](https://github.com/tanaka-mambinge), which provided the initial concept and project scaffolding for saving X posts in Obsidian.

## License

[MIT](LICENSE)
