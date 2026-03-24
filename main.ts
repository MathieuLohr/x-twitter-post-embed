import {
	App,
	Editor,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
	normalizePath,
	requestUrl,
} from "obsidian";

// --- Settings ---

interface XPostEmbedSettings {
	tweetsFolder: string;
	enableAuthorPages: boolean;
	authorPagesFolder: string;
	authorPageOrder: "newest" | "oldest";
	copyPathToClipboard: boolean;
	openAfterSave: boolean;
	pasteFormat: "blockquote" | "callout" | "plain";
	autoPasteEmbed: boolean;
	saveOnPaste: boolean;
	includeTweetDate: boolean;
	includeMedia: boolean;
	includeCommunityNote: boolean;
	includeMetrics: boolean;
	includeAuthorBio: boolean;
	metadataAtTop: boolean;
	separatorPosition: "none" | "above" | "below" | "both";
}

const DEFAULT_SETTINGS: XPostEmbedSettings = {
	tweetsFolder: "Tweets",
	enableAuthorPages: true,
	authorPagesFolder: "Tweets/Authors",
	authorPageOrder: "newest",
	copyPathToClipboard: true,
	openAfterSave: false,
	pasteFormat: "blockquote",
	autoPasteEmbed: true,
	saveOnPaste: false,
	includeTweetDate: false,
	includeMedia: true,
	includeCommunityNote: true,
	includeMetrics: false,
	includeAuthorBio: false,
	metadataAtTop: false,
	separatorPosition: "none",
};

// --- Helpers ---

function extractTweetId(url: string): string | null {
	const match = url.match(/\/status\/(\d+)/);
	return match ? match[1] : null;
}

interface FxTweet {
	text?: string;
	url?: string;
	created_at?: string;
	likes?: number;
	reposts?: number;
	replies?: number;
	views?: number;
	bookmarks?: number;
	community_note?: string;
	author?: {
		name?: string;
		screen_name?: string;
		description?: string;
		location?: string;
		followers?: number;
	};
	media?: {
		all?: { url: string }[];
	};
	quote?: FxTweet;
	replying_to?: {
		screen_name?: string;
		post?: string;
	} | null;
}

interface FxThreadResponse {
	code: number;
	status: FxTweet;
	thread?: FxTweet[];
	author?: FxTweet["author"];
}

interface FxSingleResponse {
	code: number;
	tweet?: FxTweet;
	message?: string;
}

interface OEmbedResponse {
	url: string;
	author_name: string;
	author_url: string;
	html: string;
}

interface TweetData {
	url: string;
	author_name: string;
	author_screen_name: string;
	author_url: string;
	tweet_text: string; // The primary or focal tweet text
	thread_texts: string[]; // All texts in the thread, including the primary tweet
	tweet_date: string | null;
	media_urls?: string[];
	community_note?: string | null;
	metrics?: {
		likes: number;
		reposts: number;
		replies: number;
		views: number;
		bookmarks: number;
	} | null;
	author_bio?: {
		description: string;
		location: string;
		followers: number;
	} | null;
}

// --- Modal (existing "Save X Post" feature) ---

class TweetUrlModal extends Modal {
	private onSubmit: (url: string, openAfterSave: boolean) => void;
	private openAfterSave: boolean;

	constructor(
		app: App,
		onSubmit: (url: string, openAfterSave: boolean) => void,
		openAfterSave: boolean
	) {
		super(app);
		this.onSubmit = onSubmit;
		this.openAfterSave = openAfterSave;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Save X post" });

		const inputEl = contentEl.createEl("input", {
			type: "text",
			placeholder: "Paste tweet URL here...",
		});
		inputEl.addClass("x-post-embed-input");

		const controlsRow = contentEl.createDiv({
			cls: "x-post-embed-controls-row",
		});

		const pasteBtn = controlsRow.createEl("button", {
			text: "Paste from clipboard",
		});
		pasteBtn.addClass("mod-cta");
		pasteBtn.addEventListener("click", () => {
			void (async () => {
				try {
					const text = await navigator.clipboard.readText();
					inputEl.value = text;
				} catch {
					new Notice("Failed to read clipboard");
				}
			})();
		});

		const openToggle = new Setting(controlsRow)
			.setName("Open after saving")
			.addToggle((toggle) =>
				toggle
					.setValue(this.openAfterSave)
					.onChange((value) => {
						this.openAfterSave = value;
					})
			);
		openToggle.settingEl.addClass("x-post-embed-inline-toggle");

		const submitBtn = contentEl.createEl("button", { text: "Save" });
		submitBtn.addClass("mod-cta");
		submitBtn.addClass("x-post-embed-submit");
		submitBtn.addEventListener("click", () => {
			this.onSubmit(inputEl.value, this.openAfterSave);
			this.close();
		});

		inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				this.onSubmit(inputEl.value, this.openAfterSave);
				this.close();
			}
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

// --- Plugin ---

export default class XPostEmbedPlugin extends Plugin {
	settings: XPostEmbedSettings = DEFAULT_SETTINGS;

	async onload() {
		await this.loadSettings();

		// Ribbon icon
		this.addRibbonIcon("twitter", "Save X post", () => {
			this.openTweetUrlModal();
		});

		// Command palette
		this.addCommand({
			id: "save-x-post",
			name: "Save X post",
			callback: () => {
				this.openTweetUrlModal();
			},
		});

		// Parse unparsed tweet links command
		this.addCommand({
			id: "parse-unparsed-links",
			name: "Parse unparsed tweet links in current note",
			editorCallback: async (editor: Editor) => {
				await this.parseUnparsedLinks(editor);
			},
		});

		// Ribbon icon for parse-unparsed-links
		this.addRibbonIcon("scan-search", "Parse unparsed tweet links", async () => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!view) {
				new Notice("No active Markdown editor.");
				return;
			}
			await this.parseUnparsedLinks(view.editor);
		});

		// Settings tab
		this.addSettingTab(new XPostEmbedSettingTab(this.app, this));

		// --- Paste handler (new feature) ---
		this.registerEvent(
			this.app.workspace.on(
				"editor-paste",
				async (
					evt: ClipboardEvent,
					editor: Editor,
					_info: MarkdownView
				) => {
					if (evt.defaultPrevented) return;
					if (!this.settings.autoPasteEmbed) return;

					const text =
						evt.clipboardData?.getData("text/plain") ?? "";

					if (!text.trim()) return;

					// Find all Twitter URLs anywhere in the pasted text
					const urlRegex = /https?:\/\/(?:x\.com|twitter\.com)\/\w+\/status\/\d+(?:\?[^\s)\]]*)?/g;
					const matches = text.match(urlRegex);

					if (!matches || matches.length === 0) return;

					// Prevent default paste — we handle it
					evt.preventDefault();

					// Record cursor before replacement
					const fromCursor = editor.getCursor("from");

					// Insert raw text as placeholder
					editor.replaceSelection(text);

					const toCursor = editor.getCursor("to");

					const uniqueUrls = Array.from(new Set(matches));
					const fetchNotice = new Notice(
						uniqueUrls.length > 1
							? `\u231B Fetching ${uniqueUrls.length} tweets...`
							: "\u231B Fetching tweet...",
						0 // Duration 0 = stays until dismissed
					);

					try {

						const promises = uniqueUrls.map(url => this.fetchTweetData(url));
						const results = await Promise.allSettled(promises);

						let newText = text;
						let hasErrors = false;
						const successfulTweets: TweetData[] = [];

						for (let i = 0; i < uniqueUrls.length; i++) {
							const res = results[i];
							const url = uniqueUrls[i];
							if (res.status === "fulfilled") {
								const formatted = this.formatTweetEmbed(res.value, this.settings.pasteFormat);
								// Replace all occurrences of this URL in the text with the formatted embed
								// We surround it with newlines to ensure it renders correctly as a block element
								newText = newText.split(url).join("\n\n" + formatted + "\n\n");
								successfulTweets.push(res.value);
							} else {
								hasErrors = true;
							}
						}

						// Clean up excessive newlines caused by consecutive replacements
						newText = newText.replace(/\n{3,}/g, "\n\n");

						// Safety: verify URL is still at recorded position
						const currentText = editor.getRange(fromCursor, toCursor);
						if (currentText === text) {
							editor.replaceRange(newText, fromCursor, toCursor);
						} else {
							// User edited the area during fetch — insert at cursor
							new Notice(
								"Tweets fetched. Original position changed; inserting at cursor."
							);
							editor.replaceSelection("\n" + newText);
						}

						fetchNotice.hide();

						if (hasErrors) {
							new Notice("Failed to fetch some tweets. Left as raw links");
						}

						// Save pasted tweets as notes + update author pages
						if (this.settings.saveOnPaste && successfulTweets.length > 0) {
							void Promise.allSettled(
								successfulTweets.map(data =>
									this.saveTweetAsNote(data).catch(e => {
										console.error("Failed to save pasted tweet:", e);
									})
								)
							);
						}
					} catch {
						fetchNotice.hide();
						new Notice(
							"Failed to fetch tweets, links left as-is"
						);
					}
				}
			)
		);
	}

	// --- Data fetching (FxTwitter primary, oEmbed fallback) ---

	async fetchTweetData(tweetUrl: string): Promise<TweetData> {
		// Try FxTwitter API first (returns full, untruncated text and threads)
		try {
			return await this.fetchFromFxTwitter(tweetUrl);
		} catch {
			// Fall back to oEmbed (may truncate long tweets and no thread support)
			return await this.fetchFromOEmbed(tweetUrl);
		}
	}

	// --- FxTwitter API (primary) ---

	async fetchFromFxTwitter(tweetUrl: string): Promise<TweetData> {
		const tweetId = extractTweetId(tweetUrl);
		if (!tweetId) throw new Error("Could not extract tweet ID");

		const apiUrl = `https://api.fxtwitter.com/2/thread/${tweetId}`;

		const response = await this.requestWithRetries(
			() => requestUrl({ url: apiUrl, method: "GET" }),
			3,
			2000
		);

		const json = response.json as FxThreadResponse;
		if (json.code !== 200 || !json.status) {
			// Try single status endpoint if thread fails
			const singleApiUrl = `https://api.fxtwitter.com/i/status/${tweetId}`;
			const singleResponse = await requestUrl({ url: singleApiUrl, method: "GET" });
			const singleJson = singleResponse.json as FxSingleResponse;

			if (singleJson.code !== 200 || !singleJson.tweet) {
				throw new Error(singleJson.message || "FxTwitter API error");
			}

			const tweet: FxTweet = singleJson.tweet;
			const author = tweet.author ?? {};
			const date = this.formatDateFromFx(tweet.created_at ?? "");

			// Try to reconstruct thread if this tweet is part of a self-thread
			let thread_texts: string[];
			if (tweet.replying_to?.post && tweet.replying_to?.screen_name?.toLowerCase() === (author.screen_name ?? "").toLowerCase()) {
				const threadTweets = await this.reconstructThread(tweet);
				thread_texts = threadTweets.map((t: FxTweet) => this.extractTextWithQuotes(t));
			} else {
				thread_texts = [this.extractTextWithQuotes(tweet)];
			}

			return {
				url: tweet.url || tweetUrl,
				author_name: author.name || author.screen_name || "Unknown",
				author_screen_name: author.screen_name || "",
				author_url: author.screen_name
					? `https://x.com/${author.screen_name}`
					: "",
				tweet_text: tweet.text || "",
				thread_texts,
				tweet_date: date,
				media_urls: tweet.media?.all?.map((m: { url: string }) => m.url) || [],
				community_note: tweet.community_note || null,
				metrics: {
					likes: tweet.likes || 0,
					reposts: tweet.reposts || 0,
					replies: tweet.replies || 0,
					views: tweet.views || 0,
					bookmarks: tweet.bookmarks || 0,
				},
				author_bio: {
					description: author.description || "",
					location: author.location || "",
					followers: author.followers || 0,
				},
			};
		}

		const focalTweet: FxTweet = json.status;
		const author = focalTweet.author ?? json.author ?? {};

		let thread_texts: string[] = [];
		if (json.thread && Array.isArray(json.thread) && json.thread.length > 0) {
			thread_texts = json.thread.map((t: FxTweet) => this.extractTextWithQuotes(t));
		} else if (focalTweet.replying_to?.post && focalTweet.replying_to?.screen_name?.toLowerCase() === (focalTweet.author?.screen_name ?? author.screen_name ?? "").toLowerCase()) {
			// Thread endpoint returned null/empty — reconstruct by walking reply chain
			const threadTweets = await this.reconstructThread(focalTweet);
			thread_texts = threadTweets.map((t: FxTweet) => this.extractTextWithQuotes(t));
		} else {
			thread_texts = [this.extractTextWithQuotes(focalTweet)];
		}

		const date = this.formatDateFromFx(focalTweet.created_at ?? "");

		return {
			url: focalTweet.url || tweetUrl,
			author_name: author.name || author.screen_name || "Unknown",
			author_screen_name: author.screen_name || "",
			author_url: author.screen_name
				? `https://x.com/${author.screen_name}`
				: "",
			tweet_text: focalTweet.text || "",
			thread_texts,
			tweet_date: date,
			media_urls: focalTweet.media?.all?.map((m: { url: string }) => m.url) || [],
			community_note: focalTweet.community_note || null,
			metrics: {
				likes: focalTweet.likes || 0,
				reposts: focalTweet.reposts || 0,
				replies: focalTweet.replies || 0,
				views: focalTweet.views || 0,
				bookmarks: focalTweet.bookmarks || 0,
			},
			author_bio: {
				description: author.description || "",
				location: author.location || "",
				followers: author.followers || 0,
			},
		};
	}

	private formatDateFromFx(dateStr: string): string | null {
		if (dateStr) {
			try {
				const d = new Date(dateStr);
				if (!isNaN(d.getTime())) {
					const datePart = d.toLocaleDateString("en-US", {
						year: "numeric",
						month: "short",
						day: "numeric",
					});
					if (this.settings.includeTweetDate) {
						const timePart = d.toLocaleTimeString("en-US", {
							hour: "numeric",
							minute: "2-digit",
						});
						return `${datePart} ° ${timePart}`;
					}
					return datePart;
				}
			} catch {
				return null;
			}
		}
		return null;
	}

	/**
	 * Walk the replying_to chain backwards to reconstruct a self-thread.
	 * Returns tweets in chronological order (oldest first).
	 */
	private async reconstructThread(focalTweet: FxTweet): Promise<FxTweet[]> {
		const authorScreenName = focalTweet.author?.screen_name?.toLowerCase();
		if (!authorScreenName) return [focalTweet];

		const tweets: FxTweet[] = [focalTweet];
		let current = focalTweet;
		const maxDepth = 50; // Safety limit

		while (tweets.length < maxDepth) {
			const parentId = current.replying_to?.post;
			const parentAuthor = current.replying_to?.screen_name?.toLowerCase();

			// Stop if no parent, or parent is a different author (not a self-thread)
			if (!parentId || parentAuthor !== authorScreenName) break;

			try {
				const apiUrl = `https://api.fxtwitter.com/i/status/${parentId}`;
				const response = await this.requestWithRetries(
					() => requestUrl({ url: apiUrl, method: "GET" }),
					2,
					1000
				);

				if (!response || response.status !== 200) {
					console.warn(`[XPostEmbed] Failed to fetch parent tweet ${parentId}: HTTP ${response?.status}`);
					break;
				}

				const json = response.json as FxSingleResponse;
				if (json.code !== 200 || !json.tweet) {
					console.warn(`[XPostEmbed] Unexpected API response for tweet ${parentId}:`, json);
					break;
				}

				tweets.unshift(json.tweet); // Prepend (oldest first)
				current = json.tweet;

				// Delay between requests to avoid rate-limiting by FxTwitter
				await new Promise(resolve => setTimeout(resolve, 500));
			} catch (error) {
				console.error(`[XPostEmbed] Error fetching parent tweet ${parentId}:`, error);
				break;
			}
		}

		return tweets;
	}

	private extractTextWithQuotes(tweet: FxTweet): string {
		let text = tweet.text || "";
		if (tweet.quote) {
			const quoteAuthor =
				tweet.quote.author?.screen_name ||
				tweet.quote.author?.name ||
				"Unknown";
			const quoteText = this.extractTextWithQuotes(tweet.quote);
			// Append the quote formatted as a nested quote block
			text += `\n\n> [!quote] Quoting @${quoteAuthor}\n> ${quoteText.replace(
				/\n/g,
				"\n> "
			)}`;
		}

		return text;
	}

	// --- oEmbed API (fallback) ---

	async fetchFromOEmbed(tweetUrl: string): Promise<TweetData> {
		const encodedUrl = encodeURIComponent(tweetUrl);
		const apiUrl = `https://publish.twitter.com/oembed?url=${encodedUrl}`;

		const response = await this.requestWithRetries(
			() => requestUrl({ url: apiUrl, method: "GET" }),
			3,
			2000
		);

		const { url, author_name, author_url, html } = response.json as OEmbedResponse;
		const tweet_text = this.extractTweetText(html);
		const tweet_date = this.extractTweetDate(html);

		// Extract screen name from author_url (e.g. https://twitter.com/user123 -> user123)
		const screenNameMatch = author_url?.match(/(?:twitter\.com|x\.com)\/([\w]+)/);
		const author_screen_name = screenNameMatch ? screenNameMatch[1] : "";

		return {
			url,
			author_name,
			author_screen_name,
			author_url,
			tweet_text,
			thread_texts: [tweet_text],
			tweet_date
		};
	}

	// --- Shared utilities ---

	async fetchWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
		const timeout = new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error(`Request timed out after ${ms}ms`)), ms)
		);
		return Promise.race([promise, timeout]);
	}

	async requestWithRetries<T>(
		fn: () => Promise<T>,
		retries: number,
		delay: number
	): Promise<T> {
		for (let i = 0; i < retries; i++) {
			try {
				return await this.fetchWithTimeout(fn(), 5000);
			} catch (e) {
				if (i === retries - 1) throw e;
				await new Promise((r) => setTimeout(r, delay));
			}
		}
		throw new Error("Max retries exhausted");
	}

	extractTweetText(html: string): string {
		try {
			const parser = new DOMParser();
			const doc = parser.parseFromString(html, "text/html");
			const tweetParagraph = doc.querySelector(
				"blockquote.twitter-tweet p"
			);

			if (!tweetParagraph) return "";

			// Convert <br> to newlines
			tweetParagraph
				.querySelectorAll("br")
				.forEach((br) => br.replaceWith("\n"));

			let text = tweetParagraph.textContent || "";

			// Remove trailing t.co links
			text = text.replace(/\s*https:\/\/t\.co\/\w+\s*$/g, "").trim();

			return text;
		} catch {
			return "";
		}
	}

	extractTweetDate(html: string): string | null {
		try {
			const parser = new DOMParser();
			const doc = parser.parseFromString(html, "text/html");
			const links = doc.querySelectorAll("blockquote.twitter-tweet a");
			const lastLink = links[links.length - 1];
			if (lastLink && lastLink.textContent) {
				return lastLink.textContent.trim();
			}
			return null;
		} catch {
			return null;
		}
	}

	// --- Format for inline embed ---

	formatTweetEmbed(
		data: TweetData,
		format: "blockquote" | "callout" | "plain"
	): string {
		const { url, author_name, thread_texts, tweet_date, media_urls, community_note, metrics } = data;

		// Join thread texts with a blank line between them, then format quotes
		let combinedText = thread_texts.join("\n\n");

		if (this.settings.includeCommunityNote && community_note) {
			combinedText += `\n\n> [!warning] Community Note:\n> ${community_note.replace(/\n/g, "\n> ")}`;
		}

		if (this.settings.includeMedia && media_urls && media_urls.length > 0) {
			media_urls.forEach(mUrl => {
				combinedText += `\n\n![Embedded Media](${mUrl})`;
			});
		}

		let footer = `\u2014 @${author_name}${this.settings.includeTweetDate && tweet_date ? ` \u2014 ${tweet_date}` : ""} ([Source](${url}))`;

		if (this.settings.includeMetrics && metrics) {
			footer += `\n💬 ${metrics.replies} | 🔁 ${metrics.reposts} | ❤️ ${metrics.likes} | 👁️ ${metrics.views} | 🔖 ${metrics.bookmarks}`;
		}

		const lines = combinedText.replace(/\n/g, "\n> ");

		let result: string;
		switch (format) {
			case "callout": {
				const displayDate =
					tweet_date ??
					new Date().toLocaleDateString("en-US", {
						year: "numeric",
						month: "short",
						day: "numeric",
					});
				let calloutLines = lines;
				const footerLines = footer.replace(/\n/g, "\n> ");
				if (this.settings.metadataAtTop) {
					result = `> [!quote] @${author_name} \u2014 ${displayDate}\n> ${footerLines}\n>\n> ${calloutLines}`;
				} else {
					result = `> [!quote] @${author_name} \u2014 ${displayDate}\n> ${calloutLines}\n>\n> ${footerLines}`;
				}
				break;
			}
			case "plain":
				result = this.settings.metadataAtTop ? `${footer}\n\n${combinedText}` : `${combinedText}\n\n${footer}`;
				break;
			case "blockquote":
			default:
				result = this.settings.metadataAtTop ? `> ${footer.replace(/\n/g, "\n> ")}\n>\n> ${lines}` : `> ${lines}\n> ${footer.replace(/\n/g, "\n> ")}`;
				break;
		}

		const sep = this.settings.separatorPosition;
		if (sep === "above" || sep === "both") result = `---\n${result}`;
		if (sep === "below" || sep === "both") result = `${result}\n---`;

		return result;
	}

	// --- Parse unparsed tweet links in-place ---

	async parseUnparsedLinks(editor: Editor): Promise<void> {
		const content = editor.getValue();

		// Match all tweet URLs in the document
		const urlRegex =
			/https?:\/\/(?:x\.com|twitter\.com)\/\w+\/status\/\d+(?:\?[^\s)\]]*)?/g;
		const allUrls = content.match(urlRegex) || [];

		if (allUrls.length === 0) {
			new Notice("No tweet links found in the current note.");
			return;
		}

		// A URL is "already parsed" if it appears inside a markdown link [text](URL)
		// Bare URLs (not wrapped) are the ones we need to process
		const bareUrls = allUrls.filter((url) => {
			const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const insideMdLink = new RegExp(`\\]\\(${escapedUrl}\\)`);
			return !insideMdLink.test(content);
		});

		const uniqueUrls = Array.from(new Set(bareUrls));

		if (uniqueUrls.length === 0) {
			new Notice("All tweet links in this note are already parsed.");
			return;
		}

		const parseNotice = new Notice(`\u231B Fetching ${uniqueUrls.length} new tweet(s)...`, 0);

		// Process in chunks of 3 to avoid flooding the FxTwitter API
		const results: PromiseSettledResult<TweetData>[] = [];
		const chunkSize = 3;
		for (let i = 0; i < uniqueUrls.length; i += chunkSize) {
			const chunk = uniqueUrls.slice(i, i + chunkSize);
			const chunkResults = await Promise.allSettled(chunk.map(url => this.fetchTweetData(url)));
			results.push(...chunkResults);
			if (i + chunkSize < uniqueUrls.length) {
				await new Promise(r => setTimeout(r, 1500));
			}
		}

		parseNotice.hide();

		let newContent = content;
		let hasErrors = false;
		const successfulTweets: TweetData[] = [];

		for (let i = 0; i < uniqueUrls.length; i++) {
			const res = results[i];
			const url = uniqueUrls[i];
			if (res.status === "fulfilled") {
				const formatted = this.formatTweetEmbed(res.value, this.settings.pasteFormat);
				newContent = newContent.split(url).join("\n\n" + formatted + "\n\n");
				successfulTweets.push(res.value);
			} else {
				hasErrors = true;
			}
		}

		// Clean up excessive newlines
		newContent = newContent.replace(/\n{3,}/g, "\n\n");
		editor.setValue(newContent);

		if (hasErrors) {
			new Notice("Some tweets failed to fetch and were left as raw links");
		}

		// Write notes sequentially to prevent vault index race conditions
		if (successfulTweets.length > 0) {
			let savedCount = 0;
			for (const data of successfulTweets) {
				try {
					await this.saveTweetAsNote(data);
					savedCount++;
				} catch (e) {
					console.error("[XPostEmbed] Failed to save parsed tweet as note:", e);
				}
			}
			new Notice(`Parsed ${successfulTweets.length} tweet(s). ${savedCount} saved as note(s).`);
		} else {
			new Notice("No new tweets were successfully parsed.");
		}
	}

	// --- Save as note (existing feature) ---

	openTweetUrlModal() {
		new TweetUrlModal(
			this.app,
			(tweetUrl: string, openAfterSave: boolean) => {
				if (!tweetUrl.trim()) {
					new Notice("Please enter a valid tweet URL");
					return;
				}

				const modalNotice = new Notice("\u231B Fetching tweet data...", 0);
				void (async () => {
					try {
						const tweetData = await this.fetchTweetData(tweetUrl);
						modalNotice.hide();
						const savedPath = await this.saveTweetAsNote(tweetData);
						new Notice("Tweet saved successfully!");

						if (this.settings.copyPathToClipboard) {
							const wikiLink = `[[${savedPath.replace(
								/\.md$/,
								""
							)}]]`;
							await navigator.clipboard.writeText(wikiLink);
							new Notice("Wiki link copied to clipboard!");
						}

						if (openAfterSave) {
							const file =
								this.app.vault.getAbstractFileByPath(savedPath);
							if (file && file instanceof TFile) {
								await this.app.workspace
									.getLeaf()
									.openFile(file);
							}
						}
					} catch {
						modalNotice.hide();
						new Notice("Error fetching tweet data");
					}
				})();
			},
			this.settings.openAfterSave
		).open();
	}

	async saveTweetAsNote(data: TweetData): Promise<string> {
		const tweetsFolder = normalizePath(this.settings.tweetsFolder);

		// Ensure folder exists
		const folder = this.app.vault.getAbstractFileByPath(tweetsFolder);
		if (!folder) {
			await this.app.vault.createFolder(tweetsFolder);
		} else if (!(folder instanceof TFolder)) {
			throw new Error(`${tweetsFolder} exists but is not a folder`);
		}

		const sanitized = this.sanitizeFileName(
			`${data.author_name} - ${data.tweet_text.slice(0, 50)}`
		);
		let filePath = normalizePath(`${tweetsFolder}/${sanitized}.md`);

		// Avoid overwriting
		let counter = 1;
		while (this.app.vault.getAbstractFileByPath(filePath)) {
			filePath = normalizePath(`${tweetsFolder}/${sanitized} (${counter}).md`);
			counter++;
		}

		const body = this.createMarkdownBody(data);
		const file = await this.app.vault.create(filePath, body);
		await this.applyTweetFrontmatter(file, data);

		// Save to author page if enabled
		if (this.settings.enableAuthorPages) {
			try {
				await this.saveToAuthorPage(data, filePath);
			} catch (e) {
				console.error("Failed to update author page:", e);
				new Notice("Tweet saved, but author page update failed.");
			}
		}

		return filePath;
	}

	async saveToAuthorPage(data: TweetData, individualNotePath: string): Promise<void> {
		const authorPagesFolder = normalizePath(this.settings.authorPagesFolder);
		const { authorPageOrder } = this.settings;

		// Ensure author pages folder exists
		const folder = this.app.vault.getAbstractFileByPath(authorPagesFolder);
		if (!folder) {
			await this.app.vault.createFolder(authorPagesFolder);
		} else if (!(folder instanceof TFolder)) {
			throw new Error(`${authorPagesFolder} exists but is not a folder`);
		}

		const screenName = data.author_screen_name || this.sanitizeFileName(data.author_name);
		const authorFilePath = normalizePath(`${authorPagesFolder}/${screenName}.md`);

		// The embed link (without .md extension for Obsidian wiki-link)
		const embedLink = `![[${individualNotePath.replace(/\.md$/, "")}]]`;

		const existingFile = this.app.vault.getAbstractFileByPath(authorFilePath);

		if (existingFile && existingFile instanceof TFile) {
			// Author page exists — append or prepend the new embed
			await this.app.vault.process(existingFile, (currentContent) => {
				// Skip if this embed already exists on the author page
				if (currentContent.includes(embedLink)) return currentContent;

				if (authorPageOrder === "newest") {
					// Insert right after the heading line (# Tweets by ...)
					const headingMatch = currentContent.match(/^(#\s+Tweets by .+\n)/m);
					if (headingMatch && headingMatch.index !== undefined) {
						const insertPos = headingMatch.index + headingMatch[0].length;
						return currentContent.slice(0, insertPos) +
							"\n" + embedLink + "\n" +
							currentContent.slice(insertPos);
					} else {
						// No heading found — prepend after frontmatter
						const fmEnd = currentContent.indexOf("---", currentContent.indexOf("---") + 3);
						if (fmEnd !== -1) {
							const insertPos = currentContent.indexOf("\n", fmEnd) + 1;
							return currentContent.slice(0, insertPos) +
								"\n" + embedLink + "\n" +
								currentContent.slice(insertPos);
						} else {
							return embedLink + "\n\n" + currentContent;
						}
					}
				} else {
					// Oldest first — append at end
					return currentContent.trimEnd() + "\n\n" + embedLink + "\n";
				}
			});
		} else {
			// Create new author page
			const screenNameForPage = data.author_screen_name || this.sanitizeFileName(data.author_name);
			const body = this.createAuthorPageBody(data.author_name, screenNameForPage, embedLink);
			const file = await this.app.vault.create(authorFilePath, body);
			await this.applyAuthorFrontmatter(file, data);
		}
	}

	private createAuthorPageBody(authorName: string, screenName: string, embedLink: string): string {
		return [
			`# Tweets by ${authorName} (@${screenName})`,
			"",
			embedLink,
			"",
		].join("\n");
	}

	private async applyAuthorFrontmatter(file: TFile, data: TweetData): Promise<void> {
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			fm.author = data.author_name;
			fm.author_screen_name = data.author_screen_name || this.sanitizeFileName(data.author_name);
			fm.author_url = data.author_url;
			if (data.author_bio) {
				fm.author_description = data.author_bio.description;
				fm.author_location = data.author_bio.location;
				fm.author_followers = data.author_bio.followers;
			}
		});
	}

	sanitizeFileName(name: string): string {
		return name.replace(/[\\/:*?"<>|#^[\]]/g, "").trim();
	}

	createMarkdownBody(data: TweetData): string {
		let combinedText = data.thread_texts.join("\n\n");

		if (this.settings.includeCommunityNote && data.community_note) {
			combinedText += `\n\n> [!warning] Community Note:\n> ${data.community_note.replace(/\n/g, "\n> ")}`;
		}

		if (this.settings.includeMedia && data.media_urls && data.media_urls.length > 0) {
			data.media_urls.forEach(mUrl => {
				combinedText += `\n\n![Embedded Media](${mUrl})`;
			});
		}

		let footer = `[View original](${data.url})`;
		if (this.settings.includeMetrics && data.metrics) {
			footer += `\n💬 ${data.metrics.replies} | 🔁 ${data.metrics.reposts} | ❤️ ${data.metrics.likes} | 👁️ ${data.metrics.views} | 🔖 ${data.metrics.bookmarks}`;
		}

		return [
			`# Tweet by ${data.author_name}`,
			"",
			...(this.settings.metadataAtTop ? [footer, ""] : []),
			`> ${combinedText.replace(/\n/g, "\n> ")}`,
			...(this.settings.metadataAtTop ? [] : ["", footer]),
			"",
		].join("\n");
	}

	private async applyTweetFrontmatter(file: TFile, data: TweetData): Promise<void> {
		const now = new Date().toISOString();
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			fm.author = data.author_name;
			fm.author_url = data.author_url;
			if (this.settings.includeAuthorBio && data.author_bio) {
				fm.author_description = data.author_bio.description;
				fm.author_location = data.author_bio.location;
				fm.author_followers = data.author_bio.followers;
			}
			fm.tweet_url = data.url;
			fm.saved_at = now;
			fm.tweet_date = data.tweet_date ?? "";
		});
	}

	// --- Settings persistence ---

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData() as Partial<XPostEmbedSettings>
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// --- Settings Tab ---

class XPostEmbedSettingTab extends PluginSettingTab {
	plugin: XPostEmbedPlugin;

	constructor(app: App, plugin: XPostEmbedPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// --- Existing settings ---

		new Setting(containerEl).setName("Save to note").setHeading();

		new Setting(containerEl)
			.setName("Tweets folder")
			.setDesc("Folder where saved tweets are stored.")
			.addText((text) =>
				text
					.setPlaceholder("Tweets")
					.setValue(this.plugin.settings.tweetsFolder)
					.onChange(async (value) => {
						this.plugin.settings.tweetsFolder =
							value || "Tweets";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Enable author pages")
			.setDesc("Create a per-author page that aggregates all saved tweets from each author using embedded transclusion.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableAuthorPages)
					.onChange(async (value) => {
						this.plugin.settings.enableAuthorPages = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Author pages folder")
			.setDesc("Folder where per-author aggregation pages are stored.")
			.addText((text) =>
				text
					.setPlaceholder("Tweets/authors")
					.setValue(this.plugin.settings.authorPagesFolder)
					.onChange(async (value) => {
						this.plugin.settings.authorPagesFolder =
							value || "Tweets/Authors";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Author page order")
			.setDesc("Whether new tweets are added at the top (newest first) or bottom (oldest first) of the author page.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("newest", "Newest first")
					.addOption("oldest", "Oldest first")
					.setValue(this.plugin.settings.authorPageOrder)
					.onChange(async (value: string) => {
						this.plugin.settings.authorPageOrder = value as
							| "newest"
							| "oldest";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Copy wiki link to clipboard")
			.setDesc(
				"Copy a wiki-link to the saved note after saving a tweet."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.copyPathToClipboard)
					.onChange(async (value) => {
						this.plugin.settings.copyPathToClipboard = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Open note after saving")
			.setDesc("Automatically open the saved tweet note.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.openAfterSave)
					.onChange(async (value) => {
						this.plugin.settings.openAfterSave = value;
						await this.plugin.saveSettings();
					})
			);

		// --- New paste-to-embed settings ---

		new Setting(containerEl).setName("Paste to embed").setHeading();

		new Setting(containerEl)
			.setName("Auto-embed pasted X/Twitter links")
			.setDesc(
				"When you paste an X/Twitter post URL, automatically fetch the tweet and replace the URL with formatted content."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoPasteEmbed)
					.onChange(async (value) => {
						this.plugin.settings.autoPasteEmbed = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Save pasted tweets as notes")
			.setDesc(
				"Also save each pasted tweet as a note file and update the author page (like the save X post command)."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.saveOnPaste)
					.onChange(async (value) => {
						this.plugin.settings.saveOnPaste = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Paste embed format")
			.setDesc("Choose how pasted tweets are formatted in the editor.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("blockquote", "Blockquote")
					.addOption("callout", "Callout")
					.addOption("plain", "Plain text")
					.setValue(this.plugin.settings.pasteFormat)
					.onChange(async (value: string) => {
						this.plugin.settings.pasteFormat = value as
							| "blockquote"
							| "callout"
							| "plain";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Include date and time")
			.setDesc("Append the posted date and time to the pasted tweet embed (and callout header).")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.includeTweetDate)
					.onChange(async (value) => {
						this.plugin.settings.includeTweetDate = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Place metadata at top")
			.setDesc("Place the author, source, and metrics above the tweet text instead of below it.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.metadataAtTop)
					.onChange(async (value) => {
						this.plugin.settings.metadataAtTop = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Horizontal rule separators")
			.setDesc("Add --- separators above and/or below each embedded tweet.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("none", "None")
					.addOption("above", "Above")
					.addOption("below", "Below")
					.addOption("both", "Above & below")
					.setValue(this.plugin.settings.separatorPosition)
					.onChange(async (value: string) => {
						this.plugin.settings.separatorPosition = value as
							| "none"
							| "above"
							| "below"
							| "both";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("Data extras").setHeading();

		new Setting(containerEl)
			.setName("Include media")
			.setDesc("Append image and video attachments natively rendered as Markdown images.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.includeMedia)
					.onChange(async (value) => {
						this.plugin.settings.includeMedia = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Include community note")
			.setDesc("If a tweet has a community note, append it as a warning callout.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.includeCommunityNote)
					.onChange(async (value) => {
						this.plugin.settings.includeCommunityNote = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Include engagement metrics")
			.setDesc("Append a footer with likes, reposts, replies, views, and bookmarks.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.includeMetrics)
					.onChange(async (value) => {
						this.plugin.settings.includeMetrics = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Include author bio (save command only)")
			.setDesc("Add the author's description, location, and follower count to the YAML frontmatter of the saved note.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.includeAuthorBio)
					.onChange(async (value) => {
						this.plugin.settings.includeAuthorBio = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
