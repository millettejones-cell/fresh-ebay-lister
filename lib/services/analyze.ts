import { cleanGeneratedDescription } from "@/lib/description";
import { acceptedPhotoFact, isEstimate } from "@/lib/photo-facts";
import { AI_LISTING_SCHEMA } from "@/lib/ai-schema";
import {
  parseListing,
  boundModelListing,
  imagesSchema,
  validationMessage,
} from "@/lib/validation";
import { collectUsage, currentUsage } from "@/lib/ai-usage";
import { measuredMessage } from "@/lib/ai-usage";
import { NextRequest, NextResponse } from "next/server";
import type Anthropic from "@anthropic-ai/sdk";
import {
  getClient,
  parseModelJson,
  AnthropicAuthError,
  anthropicAuthError,
} from "@/lib/anthropic";
import { guardApiRequest, safeErrorResponse } from "@/lib/api-guard";
import {
  PROFILE_ROUTER_PROMPT,
  buildProfiledAnalysisPrompt,
  normalizeItemProfile,
} from "@/lib/prompts";
import { toImageBlock, type ImageBlock } from "@/lib/images";
import { optimizeTitle } from "@/lib/titleOptimizer";
import { applyPriceMarkup, priceMarkupPercent } from "@/lib/pricing";
import { resolveEffort, resolveModel, thinksByDefault } from "@/lib/models";
import type { AnalyzeRequestBody, ListingResult } from "@/lib/types";

// Analysis takes 20-40s for a multi-photo item on a good day — and far longer
// when the API is slow. Run under the platform's 300s cap with our own budget
// (below) so a slow run fails with an error we control and a working Retry,
// not a platform kill (FUNCTION_INVOCATION_TIMEOUT).
export const maxDuration = 300;

const ANALYSIS_MODEL = "claude-opus-4-8";
const ROUTER_MODEL = "claude-sonnet-4-6";
const MAX_IMAGES = 24;

// Stop starting work once the budget is spent — headroom under maxDuration.
const ANALYZE_TIME_BUDGET_MS = 250_000;
// Per-call caps: the SDK's default timeout is 10 MINUTES, so without these one
// stalled call would eat the whole function budget. SDK-internal retries stay
// off — the loops below are the single retry layer.
const ROUTER_TIMEOUT_MS = 20_000;
const ANALYSIS_CALL_TIMEOUT_MS = 120_000;
// Don't bother starting a call with less budget than this left.
const MIN_CALL_MS = 5_000;

function toImageBlocks(images: AnalyzeRequestBody["images"]): ImageBlock[] {
  const blocks: ImageBlock[] = [];
  for (const img of images.slice(0, MAX_IMAGES)) {
    const block = toImageBlock(img);
    if (block) blocks.push(block);
  }
  return blocks;
}

// Mirrors route_item_profile(): honor a forced profile, else ask the model.
// Falls back to hard_goods when the router can't run (error or budget spent) —
// same fallback the catch below has always used.
async function routeProfile(
  client: Anthropic,
  imageBlocks: ImageBlock[],
  requested: string,
  routerModel: string,
  deadline: number,
): Promise<string> {
  const forced = normalizeItemProfile(requested);
  if (forced !== "auto") return forced;

  const remaining = deadline - Date.now();
  if (remaining < MIN_CALL_MS) return "hard_goods";

  try {
    const resp = await measuredMessage(
      "routing",
      client,
      {
        model: routerModel,
        max_tokens: 300,
        messages: [
          {
            role: "user",
            content: [
              ...imageBlocks,
              {
                type: "text",
                text: "Analyze these photos and return the listing JSON now.",
              }
            ]
          }
        ]
      },
      { timeout: Math.min(ROUTER_TIMEOUT_MS, remaining), maxRetries: 0 }
    );
    const text = firstText(resp);
    const data = parseModelJson<{ profile?: string }>(text);
    const routed = normalizeItemProfile(data?.profile ?? "auto");
    return routed !== "auto" ? routed : "hard_goods";
  } catch (e) {
    // Auth/billing failures must surface, not silently fall back to a profile.
    const fatal = anthropicAuthError(e);
    if (fatal) throw fatal;
    return "hard_goods";
  }
}

function firstText(resp: Anthropic.Message): string {
  const block = resp.content.find
