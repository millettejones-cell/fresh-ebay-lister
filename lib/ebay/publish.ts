import { parseListing, shippingSchema, skuSchema } from "@/lib/validation";
import { verifyReview } from "@/lib/review";
import { validateAspects } from "./draft";
import { boundedFetch } from "@/lib/network";
// eBay publish pipeline, ported from ebay_lister_v2_robust.py.
// Sequence: upload photos → create inventory item → create offer → publish,
// with recovery for missing item specifics, rejected conditions, and non-leaf
// categories.

import {
  EBAY_ACC_BASE,
  EBAY_CURRENCY,
  EBAY_INV_BASE,
  EBAY_MARKETPLACE_ID,
  EBAY_MEDIA_BASE,
} from "./config";
import {
  suggestLeafCategories,
  categoryAspects,
  acceptedConditionIds,
  type AspectMeta,
} from "./taxonomy";
import {
  clipAspectValue,
  cleanAspectValue,
  splitAspectValues,
  matchAllowed,
  canonicalizeAspectKeys,
  enforceCardinality,
  sanitizeNumericAspects,
  snapStandardSizes,
} from "./aspects";
import { fillRecommendedAspects } from "./aspectFill";
import { applyShoeSize } from "./shoe-size";
import {
  extractProductIdentifiers,
  hasCatalogIdentifier,
  realBrand,
} from "./identifiers";
import { parseMeasurements } from "@/lib/measurements";
import { APPAREL_CATEGORIES, PANTS_CATEGORIES } from "@/lib/categories";
import type { ListingResult } from "@/lib/types";

// ── Constants (from the Python script) ───────────────────────────────────────

const CATEGORY_MAP: Record<string, string> = {
  womens_top: "15724",
  womens_dress: "63861",
  womens_skirt: "11554",
  womens_pants: "57988",
  womens_coat: "57990",
  womens_sweater: "63864",
  womens_jeans: "11554",
  womens_clothing: "15724",
  womens_shoes: "3034",
  mens_top: "57991",
  mens_pants: "57989",
  mens_coat: "57988",
  mens_sweater: "11484",
  mens_jeans: "11483",
  mens_clothing: "1059",
  mens_shoes: "93427",
  handbag: "169291",
  wallet: "2996",
  jewelry: "281",
  scarf: "45238",
  belt: "2996",
  sunglasses: "79720",
  hat: "52382",
  accessory: "4250",
  doll: "22733",
  collectible: "1463",
  collector_plate: "1467",
  toy: "2550",
  home_decor: "10033",
  book: "267",
  knife: "7313",
  sporting_goods: "159044",
  electronics: "293",
  camera: "625",
  audio: "293",
  video_game: "139973",
  media: "11232",
  vinyl_record: "176985",
  cd: "176984",
  dvd_bluray: "617",
  musical_instrument: "619",
  kitchenware: "20625",
  glassware: "50693",
  pottery_ceramics: "24",
  art: "550",
  craft: "14339",
  tool: "631",
  automotive: "6028",
  office: "25298",
  health_beauty: "26395",
  small_appliance: "20667",
  lighting: "20697",
  linens: "20444",
  holiday: "16086",
  board_game: "233",
  puzzle: "2613",
  plush: "2624",
  action_figure: "246",
  trading_card: "183050",
  sports_memorabilia: "64482",
  coin: "11116",
  stamp: "260",
  ephemera: "165800",
  other: "99",
};

const CONDITION_ALIASES: Record<string, string> = {
  NEW: "NEW_WITH_TAGS",
  NWT: "NEW_WITH_TAGS",
  NEW_WITH_TAGS: "NEW_WITH_TAGS",
  NEW_WITH_BOX: "NEW_WITH_TAGS",
  NEW_WITHOUT_TAGS: "NEW_NO_TAGS",
  NEW_WITHOUT_BOX: "NEW_NO_TAGS",
  NEW_NO_TAGS: "NEW_NO_TAGS",
  NEW_WITH_DEFECTS: "NEW_WITH_DEFECTS",
  NEW_OTHER: "NEW_NO_TAGS",
  OPEN_BOX: "NEW_NO_TAGS",
  LIKE_NEW: "EXCELLENT",
  PREOWNED_EXCELLENT: "EXCELLENT",
  PRE_OWNED_EXCELLENT: "EXCELLENT",
  USED_EXCELLENT: "EXCELLENT",
  EXCELLENT: "EXCELLENT",
  VERY_GOOD: "VERY_GOOD",
  PREOWNED_VERY_GOOD: "VERY_GOOD",
  PRE_OWNED_VERY_GOOD: "VERY_GOOD",
  USED_VERY_GOOD: "VERY_GOOD",
  USED: "GOOD",
  PREOWNED: "GOOD",
  PRE_OWNED: "GOOD",
  USED_GOOD: "GOOD",
  PREOWNED_GOOD: "GOOD",
  PRE_OWNED_GOOD: "GOOD",
  GOOD: "GOOD",
  ACCEPTABLE: "FAIR",
  USED_ACCEPTABLE: "FAIR",
  FAIR: "FAIR",
  PREOWNED_FAIR: "FAIR",
  PRE_OWNED_FAIR: "FAIR",
  USED_FAIR: "FAIR",
  FOR_PARTS_OR_NOT_WORKING: "FOR_PARTS_OR_NOT_WORKING",
};

export const CONDITION_ID_ENUM: Record<number, string> = {
  1000: "NEW",
  1500: "NEW_OTHER",
  1750: "NEW_WITH_DEFECTS",
  2750: "LIKE_NEW",
  2990: "PRE_OWNED_EXCELLENT",
  3000: "USED_EXCELLENT",
  3010: "PRE_OWNED_FAIR",
  4000: "USED_VERY_GOOD",
  5000: "USED_GOOD",
  6000: "USED_ACCEPTABLE",
  7000: "FOR_PARTS_OR_NOT_WORKING",
};

const GENERAL_CONDITION_ID_PREFERENCES: Record<string, number[]> = {
  NEW_WITH_TAGS: [1000, 1500, 1750],
  NEW_NO_TAGS: [1500, 1000, 1750],
  EXCELLENT: [3000, 2750, 4000, 5000],
  VERY_GOOD: [4000, 3000, 5000, 2750],
  GOOD: [5000, 4000, 3000, 6000],
  FAIR: [6000, 5000, 4000, 3000],
};

const APPAREL_CONDITION_ID_PREFERENCES: Record<string, number[]> = {
  NEW_WITH_TAGS: [1000, 1500, 1750],
  NEW_NO_TAGS: [1500, 1000, 1750],
  EXCELLENT: [2990, 3000, 3010],
  VERY_GOOD: [3000, 2990, 3010],
  GOOD: [3000, 3010, 2990],
  FAIR: [3010, 3000, 2990],
};

const GENERAL_SAFE_CONDITION_IDS = [
  3000, 4000, 5000, 6000, 2750, 1500, 1000, 1750, 7000,
];
const APPAREL_SAFE_CONDITION_IDS = [3000, 2990, 3010, 1500, 1000, 1750];

const ASPECT_DEFAULTS: Record<string, string> = {};

function isSizeAspect(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("size") && !n.includes("size type");
}

const PLACEHOLDER_SIZE_RE =
  /^(see\s|refer\s|check\s|unknown\b|n\/?a\b|none\b|not\s|no\s(size|tag)|[-?]+$|tbd\b)/i;

function cleanSize(raw: unknown): string {
  const s = String(raw || "").trim();
  return PLACEHOLDER_SIZE_RE.test(s) ? "" : s;
}

// ── eBay REST client (token-authed) ──────────────────────────────────────────

interface EbayResp {
  ok: boolean;
  status: number;
  json: any;
  text: string;
}

async function ebayRequest(
  accessToken: string,
  method: string,
  url: string,
  opts: { body?: unknown; extraHeaders?: Record<string, string> } = {},
): Promise<EbayResp> {
  const resp = await boundedFetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Accept-Language": "en-US",
      ...(opts.extraHeaders || {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await resp.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON (e.g. empty 204) */
  }
  return { ok: resp.ok, status: resp.status, json, text };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function validListingPrice(
  raw: number | string | undefined,
): number | null {
  const base = typeof raw === "string" ? Number(raw) : raw;
  if (base === undefined || !Number.isFinite(base) || base <= 0) return null;
  return Math.round(base * 100) / 100;
}

export const SAFE_PACKAGE_TYPE = "PACKAGE_THICK_ENVELOPE";

interface PackageProfile {
  oz: number;
  l: number;
  w: number;
  h: number;
}

const DEFAULT_PACKAGE: PackageProfile = { oz: 16, l: 12, w: 9, h: 3 };

const PACKAGE_PROFILES: Record<string, PackageProfile> = (() => {
  const size = (
    oz: number,
    l: number,
    w: number,
    h: number,
  ): PackageProfile => ({
    oz,
    l,
    w,
    h,
  });
  const profiles: Record<string, PackageProfile> = {};
  const assign = (keys: string[], p: PackageProfile) =>
    keys.forEach((k) => (profiles[k] = p));
  assign(["womens_coat", "mens_coat"], size(40, 16, 12, 5));
  assign(["womens_shoes", "mens_shoes"], size(48, 14, 10, 6));
  assign(["handbag"], size(24, 14, 11, 4));
  assign(
    [
      "small_appliance",
      "electronics",
      "camera",
      "audio",
      "musical_instrument",
      "tool",
      "automotive",
      "kitchenware",
      "sporting_goods",
    ],
    size(48, 14, 11, 6),
  );
  assign(["art", "collector_plate"], size(48, 20, 16, 4));
  assign(
    [
      "glassware",
      "pottery_ceramics",
      "doll",
      "collectible",
      "holiday",
      "home_decor",
      "lighting",
    ],
    size(32, 12, 10, 8),
  );
  assign(
    ["book", "media", "cd", "dvd_bluray", "video_game"],
    size(12, 12, 9, 2),
  );
  assign(["vinyl_record"], size(16, 14, 14, 2));
  assign(["linens", "plush"], size(20, 14, 11, 4));
  return profiles;
})();

export function defaultPackageWeightAndSize(
  catKey: string,
): Record<string, unknown> {
  const profile = PACKAGE_PROFILES[catKey] ?? DEFAULT_PACKAGE;
  const num = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    weight: {
      value: num(process.env.EBAY_DEFAULT_PACKAGE_WEIGHT_OZ, profile.oz),
      unit: "OUNCE",
    },
    dimensions: {
      length: num(process.env.EBAY_DEFAULT_PACKAGE_LENGTH_IN, profile.l),
      width: num(process.env.EBAY_DEFAULT_PACKAGE_WIDTH_IN, profile.w),
      height: num(process.env.EBAY_DEFAULT_PACKAGE_HEIGHT_IN, profile.h),
      unit: "INCH",
    },
    packageType: SAFE_PACKAGE_TYPE,
  };
}

function normalizeConditionInput(value: string | undefined): string {
  const cleaned = (value || "GOOD")
    .trim()
    .toUpperCase()
    .replace(/['’]/g, "")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return CONDITION_ALIASES[cleaned] || "GOOD";
}

function isApparelConditionPolicy(acceptedIds: Set<number>): boolean {
  return acceptedIds.has(2990) || acceptedIds.has(3010);
}

function conditionIdsForGrade(
  grade: string,
  acceptedIds: Set<number>,
  catKey: string,
): number[] {
  if (!acceptedIds.size) return [];
  let id: number | undefined;
  if (grade === "FOR_PARTS_OR_NOT_WORKING") id = 7000;
  else if (grade === "NEW_WITH_TAGS") id = 1000;
  else if (grade === "NEW_NO_TAGS") id = 1500;
  else if (grade === "NEW_WITH_DEFECTS") id = 1750;
  else if (isApparelConditionPolicy(acceptedIds))
    id = (
      { EXCELLENT: 2990, VERY_GOOD: 3000, GOOD: 3000, FAIR: 3010 } as Record<
        string,
        number
      >
    )[grade];
  else if (![2750, 4000, 5000, 6000].some((n) => acceptedIds.has(n)))
    id = 3000; 
  else
    id = (
      { EXCELLENT: 2750, VERY_GOOD: 4000, GOOD: 5000, FAIR: 6000 } as Record<
        string,
        number
      >
    )[grade];
  return id && acceptedIds.has(id) ? [id] : [];
}

export function conditionCandidates(
  grade: string | undefined,
  acceptedIds: Set<number>,
  catKey: string,
): string[] {
  const desired = normalizeConditionInput(grade);
  const out: string[] = [];
  for (const id of conditionIdsForGrade(desired, acceptedIds, catKey)) {
    const en = CONDITION_ID_ENUM[id];
    if (en && !out.includes(en)) out.push(en);
  }
  return out;
}

function staticCategory(listing: ListingResult): string {
  const explicit = (listing.category_id || "").toString().trim();
  const catKey = (listing.category || "other").toString();
  return explicit || CATEGORY_MAP[catKey] || CATEGORY_MAP.other;
}

function singleValue(v: unknown): string {
  return splitAspectValues(v)[0] || "";
}

function departmentForCategory(catKey: string): string {
  if (catKey.startsWith("womens_")) return "Women";
  if (catKey.startsWith("mens_")) return "Men";
  return "";
}

export function buildAspects(
  listing: ListingResult,
  catKey: string,
): Record<string, string[]> {
  const aspects: Record<string, string[]> = {};
  const putOne = (k: string, v: string) => {
    const val = cleanAspectValue(v);
    if (val) aspects[k] = [val];
  };
  const putMany = (k: string, v: unknown) => {
    const vals = splitAspectValues(v);
    if (vals.length) aspects[k] = vals;
  };

  putOne("Brand", String(listing.brand || "").trim());
  putOne("Size", cleanSize(listing.size));
  putMany("Color", listing.color);
  putMany("Material", listing.material);
  putOne("Type", String(listing.item_type || "").trim());

  const feats = Array.isArray(listing.key_features) ? listing.key_features : [];
  const cleanFeats = feats
    .map((f) => cleanAspectValue(String(f)))
    .filter(Boolean)
    .slice(0, 5);
  if (cleanFeats.length) aspects.Features = cleanFeats;

  if (departmentForCategory(catKey))
    aspects.Department = [departmentForCategory(catKey)];

  if (PANTS_CATEGORIES.has(catKey)) {
    const parsed = parseMeasurements(listing.measurements);
    if (parsed.inseam) aspects.Inseam = [parsed.inseam];
    if (parsed.waist && !aspects["Waist Size"])
      aspects["Waist Size"] = [parsed.waist];
    if (parsed.rise && !aspects.Rise) aspects.Rise = [parsed.rise];
  }

  for (const [k, v] of Object.entries(listing.item_specifics || {})) {
    if (!k || k.startsWith("---")) continue;
    const vals = splitAspectValues(v);
    if (vals.length && !aspects[k]) aspects[k] = vals;
  }
  return aspects;
}

function pickDepartment(
  allowed: string[],
  listing: ListingResult,
  catKey: string,
): string {
  const text = `${catKey} ${listing.title || ""} ${listing.item_type || ""} ${
    listing.item_specifics?.Department || ""
  }`.toLowerCase();
  const women =
    catKey.startsWith("womens_") ||
    /\b(women|woman|ladies|female|girl)\b/.test(text);
  const men = catKey.startsWith("mens_") || /\b(men|man|male|boy)\b/.test(text);
  const pref = women
    ? ["Women", "Women's", "Girls", "Unisex Adults", "Unisex Kids", "Unisex"]
    : men
      ? ["Men", "Men's", "Boys", "Unisex Adults", "Unisex Kids", "Unisex"]
      : ["Unisex Adults", "Unisex Kids", "Unisex", "Women", "Men"];
  for (const p of pref) {
    const m = matchAllowed(p, allowed);
    if (m) return m;
  }
  return allowed[0] || "";
}

function freeTextDefault(name: string, listing: ListingResult): string {
  const n = name.toLowerCase();
  const clean = (v: unknown) => cleanAspectValue(String(v ?? "").trim());
  if (n.includes("brand")) return clean(listing.brand);
  if (n.includes("color")) return singleValue(listing.color);
  if (n.includes("shoe size") || n === "size") return cleanSize(listing.size);
  if (n.includes("material")) return singleValue(listing.material);
  if (n.includes("style"))
    return clean(listing.item_specifics?.Style || listing.item_type);
  if (n.includes("type")) return clean(listing.item_type);
  return "";
}

export function reconcileAspects(
  aspects: Record<string, string[]>,
  meta: AspectMeta[],
  listing: ListingResult,
  catKey: string,
): void {
  canonicalizeAspectKeys(aspects, meta);
  applyShoeSize(aspects, meta, cleanSize(listing.size), catKey);
  for (const a of meta) {
    const values = aspects[a.name];
    if (!values) continue;
    if (a.mode === "SELECTION_ONLY") {
      const valid = values
        .map((v) => matchAllowed(v, a.values))
        .filter((v): v is string => Boolean(v));
      if (valid.length) aspects[a.name] = valid;
      else delete aspects[a.name];
    }
  }
}

// ── eBay error parsing (from the script) ─────────────────────────────────────

function errorIds(r: EbayResp): number[] {
  try {
    return (r.json?.errors || []).map((e: any) => Number(e.errorId || 0));
  } catch {
    return [];
  }
}

const TRANSIENT_RETRIES = 2;
const TRANSIENT_BASE_DELAY_MS = 1500;

function isTransientEbayError(r: EbayResp): boolean {
  return r.status >= 500 || errorIds(r).includes(25001);
}

async function withTransientRetry(
  call: () => Promise<EbayResp>,
  label: string,
  sku: string,
): Promise<EbayResp> {
  let r = await call();
  for (
    let attempt = 1;
    attempt <= TRANSIENT_RETRIES && isTransientEbayError(r);
    attempt++
  ) {
    console.warn(
      `[ebay/publish] sku=${sku} ${label} hit transient eBay error ` +
        `(status=${r.status} ids=${errorIds(r).join(",") || "none"}) — retry ${attempt}/${TRANSIENT_RETRIES}`,
    );
    await new Promise((res) =>
      setTimeout(res, TRANSIENT_BASE_DELAY_MS * 2 ** (attempt - 1)),
    );
    r = await call();
  }
  return r;
}

const EBAY_ERROR_HINTS: Record<number, string> = {
  25001:
    "This is a temporary glitch on eBay's side (we already retried automatically). Wait a minute and hit Post again — the listing data itself is fine.",
  25129:
    "eBay only accepts its own standard values for this size field now. Open the listing, pick a size from the dropdown (or clear it if it's optional), and post again.",
  25019:
    "eBay rejected the listing's content — usually a restricted or trademarked word in the title/description, or the item is already listed. Edit the title/description and try again.",
};

function primaryEbayError(r: EbayResp): { errorId: number; message: string } {
  const err = r.json?.errors?.[0];
  if (err) {
    return {
      errorId: Number(err.errorId || 0),
      message: String(err.longMessage || err.message || "").trim(),
    };
  }
  return { errorId: 0, message: (r.text || "").slice(0, 3
