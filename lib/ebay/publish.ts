import { parseListing, shippingSchema, skuSchema } from "@/lib/validation";
import { verifyReview } from "@/lib/review";
import { validateAspects } from "./draft";
import { boundedFetch } from "@/lib/network";

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

// ── eBay error parsing ──────────────────────────────────────────────────────

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
  return { errorId: 0, message: (r.text || "").slice(0, 300) };
}

function publishErrorMessage(stage: string, r: EbayResp): string {
  const { errorId, message } = primaryEbayError(r);
  const detail = message || `HTTP ${r.status}`;
  const head = errorId
    ? `${stage} (eBay error ${errorId}): ${detail}`
    : `${stage} (${r.status}): ${detail}`;
  const hint = errorId ? EBAY_ERROR_HINTS[errorId] : undefined;
  return hint ? `${head} ${hint}` : head;
}

// ── Photo upload to eBay Picture Services (Media API) ─────────────────────────

async function uploadPhoto(
  accessToken: string,
  base64: string,
  mediaType: string,
  name: string,
): Promise<PhotoUpload> {
  const data = base64.includes(",") ? base64.split(",")[1] : base64;
  const bytes = Buffer.from(data, "base64");
  const form = new FormData();
  form.append(
    "image",
    new Blob([new Uint8Array(bytes)], { type: mediaType }),
    name,
  );
  const auth = { Authorization: `Bearer ${accessToken}` };
  const resp = await boundedFetch(`${EBAY_MEDIA_BASE}/image/create_image_from_file`, {
    method: "POST",
    headers: auth,
    body: form,
  });
  if (resp.status !== 201) return { error: await mediaError(resp) };
  const created = (await resp.json().catch(() => ({}))) as { imageUrl?: string };
  if (created.imageUrl) return { url: created.imageUrl };
  const location = resp.headers.get("Location");
  if (!location) return { error: "eBay did not return the uploaded photo's location." };
  const image = await boundedFetch(location, { headers: auth });
  if (!image.ok) return { error: await mediaError(image) };
  const details = (await image.json().catch(() => ({}))) as { imageUrl?: string };
  return details.imageUrl
    ? { url: details.imageUrl }
    : { error: "eBay did not return the uploaded photo's URL." };
}

async function mediaError(resp: Response): Promise<string> {
  const body = (await resp.json().catch(() => null)) as {
    errors?: { errorId?: number; message?: string; longMessage?: string }[];
  } | null;
  const e = body?.errors?.[0];
  const message = e?.longMessage || e?.message;
  if (message) return `eBay error${e?.errorId ? ` ${e.errorId}` : ""}: ${message}`;
  return `eBay returned HTTP ${resp.status}.`;
}

interface PhotoUpload {
  url?: string;
  error?: string;
}

// ── Policies & location ──────────────────────────────────────────────────────

export interface AccountOptions {
  fulfillment: { id: string; name: string }[];
  payment: { id: string; name: string }[];
  returns: { id: string; name: string }[];
  locations: { id: string; name: string }[];
}

export async function fetchAccountOptions(
  accessToken: string,
): Promise<AccountOptions> {
  const mp = "marketplace_id=" + EBAY_MARKETPLACE_ID;
  const results = await Promise.all([
    ebayRequest(
      accessToken,
      "GET",
      EBAY_ACC_BASE + "/fulfillment_policy?" + mp,
    ),
    ebayRequest(accessToken, "GET", EBAY_ACC_BASE + "/payment_policy?" + mp),
    ebayRequest(accessToken, "GET", EBAY_ACC_BASE + "/return_policy?" + mp),
    ebayRequest(accessToken, "GET", EBAY_INV_BASE + "/location?limit=100"),
  ]);
  if (results.some((r) => !r.ok))
    throw new Error(
      "Could not load all eBay policies and locations. Reconnect or retry.",
    );
  const rows = (r: EbayResp, key: string, id: string) =>
    (r.json?.[key] ?? []).map((x: any) => ({
      id: String(x[id]),
      name: String(x.name || x[id]),
    }));
  return {
    fulfillment: rows(results[0], "fulfillmentPolicies", "fulfillmentPolicyId"),
    payment: rows(results[1], "paymentPolicies", "paymentPolicyId"),
    returns: (results[2].json?.returnPolicies ?? [])
      .filter((policy: any) => policy.returnsAccepted === true)
      .map((policy: any) => ({
        id: String(policy.returnPolicyId),
        name: String(policy.name || policy.returnPolicyId),
      })),
    locations: (results[3].json?.locations ?? [])
      .filter((x: any) => x.merchantLocationStatus === "ENABLED")
      .map((x: any) => ({
        id: String(x.merchantLocationKey),
        name: [
          x.name,
          x.location?.address?.postalCode,
          x.location?.address?.country,
        ]
          .filter(Boolean)
          .join(" · "),
      })),
  };
}

// ── The full publish flow for one item ───────────────────────────────────────

export interface PublishInput {
  shipping?: import("@/lib/validation").ShippingSelection;
  review?: { categoryId: string; expiresAt: number; signature: string };
  expectedPhotoCount?: number;
  sku: string;
  listing: ListingResult;
  images?: { mediaType: string; data: string }[];
  imageUrls?: string[];
}

export function sanitizeEbayImageUrls(urls: unknown): string[] {
  if (!Array.isArray(urls)) return [];
  const out: string[] = [];
  for (const raw of urls) {
    if (typeof raw !== "string") continue;
    try {
      const u = new URL(raw);
      const host = u.hostname.toLowerCase();
      const isEps = host === "ebayimg.com" || host.endsWith(".ebayimg.com");
      if (u.protocol === "https:" && isEps && !out.includes(raw)) out.push(raw);
    } catch {
      /* not a URL — skip */
    }
  }
  return out.slice(0, 24);
}

export interface PublishResult {
  success: boolean;
  sku: string;
  listingId?: string;
  offerId?: string;
  error?: string;
  alreadyListed?: boolean;
  warnings?: string[];
}

const CL = { "Content-Language": "en-US" };

async function findPublishedOffer(
  accessToken: string,
  sku: string,
): Promise<{ offerId: string; listingId: string } | null> {
  const r = await ebayRequest(
    accessToken,
    "GET",
    `${EBAY_INV_BASE}/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${EBAY_MARKETPLACE_ID}`,
  );
  if (!r.ok) {
    if (r.status === 404 || errorIds(r).includes(25713)) return null;
    throw new Error(
      "Could not verify whether this SKU is already live. Nothing was overwritten; retry later.",
    );
  }
  for (const o of r.json?.offers ?? []) {
    if (String(o?.status || "").toUpperCase() === "PUBLISHED") {
      return {
        offerId: String(o.offerId || ""),
        listingId: String(o?.listing?.listingId || ""),
      };
    }
  }
  return null;
}

export async function uploadPhotos(
  accessToken: string,
  images: { mediaType: string; data: string }[],
  sku: string,
  nameOffset = 0,
): Promise<{ urls: string[]; errors: string[] }> {
  const results: PhotoUpload[] = new Array(images.length).fill({});
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(4, images.length) },
    async () => {
      while (cursor < images.length) {
        const i = cursor++;
        const name = `${sku}-${nameOffset + i + 1}.jpg`;
        let r = await uploadPhoto(accessToken, images[i].data, images[i].mediaType, name);
        if (!r.url)
          r = await uploadPhoto(accessToken, images[i].data, images[i].mediaType, name);
        if (!r.url) console.error(`[ebay/upload-photos] ${name} failed: ${r.error}`);
        results[i] = r;
      }
    },
  );
  await Promise.all(workers);
  return {
    urls: results.flatMap((r) => (r.url ? [r.url] : [])),
    errors: [...new Set(results.flatMap((r) => (r.url ? [] : [r.error ?? "Unknown error."])))],
  };
}

export async function publishListing(
  accessToken: string,
  input: PublishInput,
): Promise<PublishResult> {
  const sku = skuSchema.parse(input.sku);
  const listing = parseListing(input.listing);
  const shippingInput = input.shipping || {};
  const catId = listing.category_id || "";
  
  if (
    !input.review ||
    input.review.categoryId !== catId ||
    !verifyReview(catId, input.review.expiresAt, input.review.signature)
  )
    throw new Error("Prepare this category for review before publishing.");

  const price = validListingPrice(listing.suggested_price) || 0.99;
  
  if (listing.title.length > 80 || !listing.description.trim())
    throw new Error(
      "A title of 1–80 characters and a description are required.",
    );
    
  const photoUrls = sanitizeEbayImageUrls(input.imageUrls);
  if (
    !Number.isInteger(input.expectedPhotoCount) ||
    !photoUrls.length ||
    photoUrls.length !== input.expectedPhotoCount
  )
    throw new Error(
      "Every selected photo must upload before publication. Retry the failed uploads.",
    );
    
  const [meta, accepted, options] = await Promise.all([
    categoryAspects(catId),
    acceptedConditionIds(catId, accessToken),
    fetchAccountOptions(accessToken),
  ]);
  
  if (!meta.length || !accepted.size)
    throw new Error(
      "eBay category metadata is unavailable. Your draft is saved; retry later.",
    );

  // Automatically fall back to the account's first available policy/location if none provided
  const fulfillmentPolicyId = shippingInput.fulfillmentPolicyId || options.fulfillment[0]?.id;
  const paymentPolicyId = shippingInput.paymentPolicyId || options.payment[0]?.id;
  const returnPolicyId = shippingInput.returnPolicyId || options.returns[0]?.id;
  const locationKey = shippingInput.locationKey || options.locations[0]?.id;

  if (!fulfillmentPolicyId || !paymentPolicyId || !returnPolicyId || !locationKey)
    throw new Error(
      "Could not find valid default shipping, payment, or return policies in your eBay account.",
    );
    
  const condition = listing.ebay_condition || "";
  if (![...accepted].some((id) => CONDITION_ID_ENUM[id] === condition))
    throw new Error("Select a condition supported by this category.");
    
  const aspects = Object.fromEntries(
    Object.entries(listing.item_specifics ?? {})
      .filter(([, v]) => v.trim())
      .map(([k, v]) => [k, v.split(" | ").map((x) => x.trim())]),
  );
  
  for (const name of snapStandardSizes(aspects, meta))
    console.warn(
      `[ebay/publish] sku=${sku} dropped optional "${name}" — not one of eBay's standard values`,
    );
    
  const issues = validateAspects(aspects, meta);
  if (issues.length) throw new Error(issues.join("; "));
  
  const existing = await findPublishedOffer(accessToken, sku);
  if (existing)
    return {
      success: false,
      sku,
      alreadyListed: true,
      ...existing,
      error:
        "This SKU is already live. Open the existing listing to confirm the previous attempt before posting again.",
    };
    
  const identifiers = extractProductIdentifiers(listing),
    brand = realBrand(listing);
    
  const inventoryItem = {
    product: {
      title: listing.title,
      description: listing.description,
      aspects,
      imageUrls: photoUrls,
      ...(identifiers.upc ? { upc: [identifiers.upc] } : {}),
      ...(identifiers.ean ? { ean: [identifiers.ean] } : {}),
      ...(identifiers.isbn ? { isbn: [identifiers.isbn] } : {}),
      ...(identifiers.mpn && brand ? { brand, mpn: identifiers.mpn } : {}),
    },
    condition,
    conditionDescription: listing.condition_notes || "",
    availability: { shipToLocationAvailability: { quantity: 1 } },
    ...(shippingInput.weightOz !== undefined || shippingInput.lengthIn !== undefined
      ? {
          packageWeightAndSize: {
            ...(shippingInput.weightOz !== undefined
              ? { weight: { value: shippingInput.weightOz, unit: "OUNCE" } }
              : {}),
            ...(shippingInput.lengthIn !== undefined
              ? {
                  dimensions: {
                    length: shippingInput.lengthIn,
                    width: shippingInput.widthIn,
                    height: shippingInput.heightIn,
                    unit: "INCH",
                  },
                }
              : {}),
            packageType: SAFE_PACKAGE_TYPE,
          },
        }
      : {}),
  };
  
  const declinePrice = (price * 0.50).toFixed(2);

  const offerBody = {
    sku,
    marketplaceId: EBAY_MARKETPLACE_ID,
    format: "FIXED_PRICE",
    listingDescription: listing.description,
    pricingSummary: {
      price: { value: price.toFixed(2), currency: EBAY_CURRENCY },
    },
    quantityLimitPerBuyer: 1,
    categoryId: catId,
    merchantLocationKey: locationKey,
    listingPolicies: {
      fulfillmentPolicyId,
      paymentPolicyId,
      returnPolicyId,
      bestOfferTerms: {
        bestOfferEnabled: true,
        autoDeclinePrice: { value: declinePrice, currency: EBAY_CURRENCY }
      }
    },
    includeCatalogProductDetails: false,
  };
  
  const prior = await ebayRequest(
    accessToken,
    "GET",
    EBAY_INV_BASE + "/inventory_item/" + encodeURIComponent(sku),
  );
  if (!prior.ok && prior.status !== 404 && !errorIds(prior).includes(25713))
    throw new Error("Could not verify the inventory SKU before writing.");
  if (prior.ok) {
    const p = prior.json;
    if (
      p?.product?.title !== inventoryItem.product.title ||
      p?.product?.description !== inventoryItem.product.description ||
      JSON.stringify(p?.product?.imageUrls) !== JSON.stringify(photoUrls)
    )
      throw new Error(
        "This SKU already contains a different draft. Choose a unique SKU before posting this item.",
      );
  }
  
  const r = await withTransientRetry(
    () =>
      ebayRequest(
        accessToken,
        "PUT",
        EBAY_INV_BASE + "/inventory_item/" + encodeURIComponent(sku),
        { body: inventoryItem, extraHeaders: CL },
      ),
    "inventory item",
    sku,
  );
  
  if (!r.ok)
    return {
      success: false,
      sku,
      error: publishErrorMessage(
        "Inventory item rejected; review the draft",
        r,
      ),
    };
    
  const offers = await ebayRequest(
    accessToken,
    "GET",
    EBAY_INV_BASE +
      "/offer?sku=" +
      encodeURIComponent(sku) +
      "&marketplace_id=" +
      EBAY_MARKETPLACE_ID,
  );
  if (!offers.ok && offers.status !== 404 && !errorIds(offers).includes(25713))
    throw new Error(
      "Could not confirm the existing offer state. Retry to reconcile before creating an offer.",
    );
    
  const previous = (offers.json?.offers ?? []).find(
    (o: any) => o.status !== "PUBLISHED" && o.format === "FIXED_PRICE",
  );
  let offerId = previous?.offerId;
  
  const offerResp = offerId
    ? await ebayRequest(
        accessToken,
        "PUT",
        EBAY_INV_BASE + "/offer/" + offerId,
        { body: offerBody, extraHeaders: CL },
      )
    : await ebayRequest(accessToken, "POST", EBAY_INV_BASE + "/offer", {
        body: offerBody,
        extraHeaders: CL,
      });
      
  if (!offerResp.ok)
    return {
      success: false,
      sku,
      error: publishErrorMessage("Offer rejected; review the draft", offerResp),
    };
    
  offerId = offerId || offerResp.json?.offerId;
  if (!offerId)
    throw new Error(
      "eBay did not return an offer ID. Retry to reconcile the saved draft.",
    );
  
  return {
    success: true,
    sku,
    offerId,
  };
}
