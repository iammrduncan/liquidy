import type { Attachment, Message } from "discord.js";
import { errorText, log } from "./log.ts";

/** What d1 accepts. */
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_IMAGES = 4;
/**
 * d1 takes at most 10,000 32x32 patches per request and bills 1.5 tokens per patch, so images
 * are scaled to this longest side first (a 1024x1024 image is 1,024 patches).
 */
const MAX_SIDE = 1024;
/** Keeps the request under Liquid's 4.5 MB body limit once Base64 adds its third. */
const MAX_TOTAL_BYTES = 3_000_000;

/**
 * The message's images as data URLs. An image that fails to download is left out and logged:
 * the text is still judged without it.
 */
export async function collectImages(message: Message, timeoutMs: number): Promise<string[]> {
  const images: string[] = [];
  let total = 0;
  for (const attachment of message.attachments.values()) {
    if (images.length >= MAX_IMAGES) break;
    if (!IMAGE_TYPES.has(mediaType(attachment.contentType))) continue;
    try {
      const res = await fetch(scaledUrl(attachment), { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = mediaType(res.headers.get("content-type"));
      if (!IMAGE_TYPES.has(type)) throw new Error(`served as ${type || "no type"}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (total + bytes.length > MAX_TOTAL_BYTES) {
        log.warn("image left out: request would be too large", { attachmentId: attachment.id });
        continue;
      }
      total += bytes.length;
      images.push(`data:${type};base64,${bytes.toString("base64")}`);
    } catch (e) {
      log.warn("image download failed", { attachmentId: attachment.id, error: errorText(e) });
    }
  }
  return images;
}

/** The attachment through Discord's media proxy, resized so its longest side is MAX_SIDE. */
export function scaledUrl(attachment: Pick<Attachment, "proxyURL" | "width" | "height">): string {
  const { proxyURL, width, height } = attachment;
  if (!width || !height || Math.max(width, height) <= MAX_SIDE) return proxyURL;
  const scale = MAX_SIDE / Math.max(width, height);
  const url = new URL(proxyURL);
  url.searchParams.set("width", String(Math.round(width * scale)));
  url.searchParams.set("height", String(Math.round(height * scale)));
  return url.toString();
}

function mediaType(contentType: string | null | undefined): string {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}
