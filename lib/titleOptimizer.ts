// Deterministic eBay-title cleanup.
// Stripped down to strictly pass through the AI's exact generated title
// while enforcing the hard 80-character eBay limit. No appending fluff.

import type { ListingResult } from "@/lib/types";

export const EBAY_TITLE_LIMIT = 80;

// Safety net: If the AI accidentally goes over 80 characters, clip it at the last whole word
// so it doesn't leave half-words dangling at the end of the title.
function clipAtWord(title: string, limit: number): string {
  if (title.length <= limit) return title;
  const cut = title.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

export function optimizeTitle(listing: ListingResult): string {
  // 1. Grab the exact title the AI wrote based on the strict prompts
  let title = String(listing.title || "")
    // 2. Clean up any weird double spaces or line breaks
    .replace(/\s+/g, " ")
    .trim();
    
  // 3. Strictly enforce the 80-character limit
  return clipAtWord(title, EBAY_TITLE_LIMIT);
}
