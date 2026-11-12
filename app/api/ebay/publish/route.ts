import { withDeadline } from "@/lib/network";
import { validationMessage } from "@/lib/validation";
import { NextRequest, NextResponse } from "next/server";
import { EBAY_COOKIE, accessTokenFromCookie } from "@/lib/ebay/session";
import { guardApiRequest } from "@/lib/api-guard";
import { publishListing } from "@/lib/ebay/publish";
import type { PublishInput } from "@/lib/ebay/publish";

export const maxDuration = 300;

async function handle(req: NextRequest) {
  const denied = guardApiRequest(req);
  if (denied) return denied;

  let body: PublishInput;
  try {
    body = (await req.json()) as PublishInput;
  } catch {
    return NextResponse.json(
      { success: false, error: "Invalid request." },
      { status: 400 },
    );
  }

  // FORCE a brand new unique SKU every single time, ignoring whatever stale value the UI form passes
  const randomSuffix = Math.random().toString(36).substring(2, 7);
  body.sku = `BX6-${randomSuffix}`;

  const hasImages = Array.isArray(body.images) && body.images.length > 0;
  const hasImageUrls =
    Array.isArray(body.imageUrls) && body.imageUrls.length > 0;
  if (!body.sku || !body.listing || (!hasImages && !hasImageUrls)) {
    return NextResponse.json(
      { success: false, error: "Missing SKU, listing, or photos." },
      { status: 400 },
    );
  }

  let accessToken: string | null;
  try {
    accessToken = await accessTokenFromCookie(
      req.cookies.get(EBAY_COOKIE)?.value,
    );
  } catch (e) {
    return NextResponse.json(
      { success: false, error: validationMessage(e) },
      { status: 500 },
    );
  }
  if (!accessToken) {
    return NextResponse.json(
      {
        success: false,
        error: "eBay isn't connected. Connect your account and try again.",
      },
      { status: 401 },
    );
  }

  try {
    const result = await publishListing(accessToken, body);
    return NextResponse.json(result, { status: result.success ? 200 : 422 });
  } catch (e) {
    console.error(`[ebay/publish] unhandled error sku=${body.sku}:`, e);
    return NextResponse.json(
      { success: false, sku: body.sku, error: (e as Error).message },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  return withDeadline(240_000, () => handle(req));
}
