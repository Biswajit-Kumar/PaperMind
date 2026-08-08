import { CheerioWebBaseLoader } from "@langchain/community/document_loaders/web/cheerio";
import { YoutubeTranscript } from "youtube-transcript";
import * as cheerio from "cheerio";

// Load and process webpage using LangChain
const loadWebpage = async (url) => {
  try {
    // Validate URL
    const urlObj = new URL(url);
    if (!["http:", "https:"].includes(urlObj.protocol)) {
      throw new Error("Only HTTP and HTTPS URLs are supported");
    }

    // Create Cheerio web loader
    const loader = new CheerioWebBaseLoader(url, {
      selector: "body", // Load full body content
    });

    // Load documents
    const docs = await loader.load();

    if (!docs || docs.length === 0) {
      throw new Error("No content found at the provided URL");
    }

    // Get the main document
    const doc = docs[0];
    const content = doc.pageContent;

    if (!content || content.trim().length < 100) {
      throw new Error("Unable to extract meaningful content from the webpage");
    }

    // Extract URLs from the webpage
    const extractedUrls = await extractUrlsFromPage(url);

    // Clean up the content
    const cleanContent = content
      .replace(/\s+/g, " ") // Replace multiple spaces
      .replace(/\n{3,}/g, "\n\n") // Replace excessive newlines
      .trim();

    // Extract title from metadata or URL
    const title = doc.metadata?.title || extractDomainFromUrl(url);

    // Enhanced content with URLs for AI context
    const enhancedContent = formatContentWithUrls(cleanContent, extractedUrls);

    return {
      title,
      content: enhancedContent,
      extractedUrls, // Raw URLs for reference
      url: url,
      metadata: doc.metadata,
      scrapedAt: new Date(),
    };
  } catch (error) {
    throw new Error(`Error loading webpage: ${error.message}`);
  }
};

// Extract URLs from webpage using Cheerio
const extractUrlsFromPage = async (url) => {
  try {
    const response = await fetch(url);
    const html = await response.text();
    const $ = cheerio.load(html);

    const urls = {
      socialMedia: [],
      email: [],
      phone: [],
      internal: [],
      external: [],
    };

    const baseUrl = new URL(url);
    const baseDomain = baseUrl.hostname;

    // Extract all links
    $("a[href]").each((_, element) => {
      const href = $(element).attr("href");
      const linkText = $(element).text().trim();

      if (!href) return;

      try {
        let fullUrl;

        // Handle relative URLs
        if (href.startsWith("http")) {
          fullUrl = href;
        } else if (href.startsWith("//")) {
          fullUrl = baseUrl.protocol + href;
        } else if (href.startsWith("/")) {
          fullUrl = `${baseUrl.protocol}//${baseUrl.host}${href}`;
        } else if (href.startsWith("#") || href.startsWith("javascript:")) {
          return; // Skip anchors and javascript links
        } else {
          fullUrl = `${baseUrl.protocol}//${baseUrl.host}/${href}`;
        }

        const linkUrl = new URL(fullUrl);
        const linkInfo = {
          url: fullUrl,
          text: linkText,
          domain: linkUrl.hostname,
        };

        // Categorize URLs
        if (isSocialMediaUrl(fullUrl)) {
          urls.socialMedia.push(linkInfo);
        } else if (href.startsWith("mailto:")) {
          urls.email.push({
            email: href.replace("mailto:", ""),
            text: linkText,
          });
        } else if (href.startsWith("tel:")) {
          urls.phone.push({
            phone: href.replace("tel:", ""),
            text: linkText,
          });
        } else if (linkUrl.hostname === baseDomain) {
          urls.internal.push(linkInfo);
        } else {
          urls.external.push(linkInfo);
        }
      } catch {
        // Skip invalid URLs
      }
    });

    // Remove duplicates and limit results
    urls.socialMedia = removeDuplicateUrls(urls.socialMedia).slice(0, 10);
    urls.external = removeDuplicateUrls(urls.external).slice(0, 20);
    urls.internal = removeDuplicateUrls(urls.internal).slice(0, 15);

    return urls;
  } catch (error) {
    console.log("Error extracting URLs:", error.message);
    return {
      socialMedia: [],
      email: [],
      phone: [],
      internal: [],
      external: [],
    };
  }
};

// Check if URL is a social media platform
const isSocialMediaUrl = (url) => {
  const socialDomains = [
    "facebook.com",
    "fb.com",
    "twitter.com",
    "x.com",
    "instagram.com",
    "linkedin.com",
    "youtube.com",
    "youtu.be",
    "tiktok.com",
    "github.com",
    "discord.com",
    "discord.gg",
    "telegram.org",
    "t.me",
    "whatsapp.com",
    "snapchat.com",
    "pinterest.com",
    "reddit.com",
    "medium.com",
    "behance.net",
    "dribbble.com",
    "vimeo.com",
    "twitch.tv",
  ];

  return socialDomains.some((domain) => url.toLowerCase().includes(domain));
};

// Remove duplicate URLs
const removeDuplicateUrls = (urls) => {
  const seen = new Set();
  return urls.filter((item) => {
    if (seen.has(item.url)) {
      return false;
    }
    seen.add(item.url);
    return true;
  });
};

// Format content with URLs for better AI context
const formatContentWithUrls = (content, urls) => {
  let enhancedContent = content;

  // Add extracted URLs section for AI context
  if (urls.socialMedia.length > 0) {
    enhancedContent += "\n\n--- SOCIAL MEDIA LINKS ---\n";
    urls.socialMedia.forEach((link) => {
      enhancedContent += `${link.text || "Social Link"}: ${link.url}\n`;
    });
  }

  if (urls.email.length > 0) {
    enhancedContent += "\n\n--- EMAIL CONTACTS ---\n";
    urls.email.forEach((email) => {
      enhancedContent += `Email: ${email.email}\n`;
    });
  }

  if (urls.phone.length > 0) {
    enhancedContent += "\n\n--- PHONE CONTACTS ---\n";
    urls.phone.forEach((phone) => {
      enhancedContent += `Phone: ${phone.phone}\n`;
    });
  }

  if (urls.external.length > 0) {
    enhancedContent += "\n\n--- EXTERNAL LINKS ---\n";
    urls.external.slice(0, 10).forEach((link) => {
      enhancedContent += `${link.text || "External Link"}: ${link.url}\n`;
    });
  }

  return enhancedContent;
};

// Load YouTube video transcript.
//
// Uses the `youtube-transcript` package (fetches captions via the video's
// timedtext endpoint) rather than LangChain's YoutubeLoader, which calls
// YouTube's internal Innertube `get_transcript` API via youtubei.js. That
// API increasingly requires a proof-of-origin token for automated clients
// and started returning 400s for every request during testing. The
// timedtext-based approach isn't subject to that gate. Video metadata
// (title/author) comes from YouTube's public oEmbed endpoint, which is
// meant for embed cards and imposes no such restriction.
const loadYouTubeVideo = async (url) => {
  try {
    // Validate YouTube URL format
    if (!isValidYouTubeUrl(url)) {
      throw new Error("Invalid YouTube URL format");
    }

    const videoId = extractVideoId(url);
    if (!videoId) {
      throw new Error("Could not extract video ID from URL");
    }

    const [transcriptSegments, oembed] = await Promise.all([
      fetchTranscriptPreferEnglish(videoId),
      fetchYouTubeOEmbed(url),
    ]);

    if (!transcriptSegments || transcriptSegments.length === 0) {
      throw new Error("No transcript available for this video");
    }

    const transcript = transcriptSegments.map((seg) => seg.text).join(" ");

    if (!transcript || transcript.trim().length < 50) {
      throw new Error("Transcript is too short or incomplete");
    }

    const cleanTranscript = cleanTranscriptText(transcript);

    return {
      videoId,
      videoUrl: url,
      videoTitle: oembed?.title || `YouTube Video ${videoId}`,
      transcript: cleanTranscript,
      duration: "Unknown",
      author: oembed?.author_name || "Unknown",
      description: "",
      metadata: oembed || {},
    };
  } catch (error) {
    // Handle specific YouTube errors
    if (error.message.includes("disabled")) {
      throw new Error("Transcript is disabled for this video");
    }
    if (error.message.includes("unavailable")) {
      throw new Error("Video is unavailable or private");
    }
    if (error.message.includes("quota exceeded")) {
      throw new Error("YouTube API quota exceeded. Please try again later.");
    }

    throw new Error(`Error loading YouTube video: ${error.message}`);
  }
};

// Try English captions first; fall back to whatever's available (e.g. the
// video only has auto-captions in another language) rather than failing.
const fetchTranscriptPreferEnglish = async (videoId) => {
  try {
    return await YoutubeTranscript.fetchTranscript(videoId, { lang: "en" });
  } catch {
    return await YoutubeTranscript.fetchTranscript(videoId);
  }
};

// Fetch video title/author via YouTube's public oEmbed endpoint (no auth,
// no bot-detection - it's designed for embed cards on third-party sites).
const fetchYouTubeOEmbed = async (url) => {
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const res = await fetch(oembedUrl);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
};

// Validate YouTube URL
const isValidYouTubeUrl = (url) => {
  const pattern =
    /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be)\/(?:watch\?v=|embed\/|v\/)?([a-zA-Z0-9_-]{11})/;
  return pattern.test(url);
};

// Extract YouTube video ID
const extractVideoId = (url) => {
  const pattern =
    /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be)\/(?:watch\?v=|embed\/|v\/)?([a-zA-Z0-9_-]{11})/;
  const match = url.match(pattern);
  return match && match[1] ? match[1] : null;
};

// Extract domain from URL for fallback title
const extractDomainFromUrl = (url) => {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace("www.", "");
  } catch {
    return "Unknown Website";
  }
};

// Validate URL format
const isValidUrl = (url) => {
  try {
    const urlObj = new URL(url);
    return ["http:", "https:"].includes(urlObj.protocol);
  } catch {
    return false;
  }
};

// Clean transcript text
const cleanTranscriptText = (text) => {
  return text
    .replace(/\[.*?\]/g, "") // Remove [Music], [Applause], etc.
    .replace(/\(.*?\)/g, "") // Remove (speaking foreign language), etc.
    .replace(/\s+/g, " ") // Replace multiple spaces
    .replace(/\n{3,}/g, "\n\n") // Replace multiple newlines
    .trim();
};

export {
  loadWebpage,
  loadYouTubeVideo,
  isValidUrl,
  isValidYouTubeUrl,
  extractDomainFromUrl,
};
