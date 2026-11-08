"use client";

import { DraftControls } from "./DraftControls";
import { draftIssues } from "@/lib/client-review";
import { useEffect, useMemo, useState } from "react";
import { SIZE_REQUIRED_CATEGORIES } from "@/lib/categories";
import type { ItemGroup, ListingResult, Photo } from "@/lib/types";

const TITLE_LIMIT = 80;

// eBay's pre-owned condition tiers, matching the values the model returns.
const CONDITIONS: { value: string; label: string }[] = [
  { value: "NEW_WITH_TAGS", label: "New with tags" },
  { value: "NEW_NO_TAGS", label: "New without tags" },
  { value: "NEW_WITH_DEFECTS", label: "New with defects" },
  { value: "EXCELLENT", label: "Pre-owned · Excellent" },
  { value: "VERY_GOOD", label: "Pre-owned · Very good" },
  { value: "GOOD", label: "Pre-owned · Good" },
  { value: "FAIR", label: "Pre-owned · Fair" },
  { value: "FOR_PARTS_OR_NOT_WORKING", label: "For parts / not working" },
];

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className="btn-ghost"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        } catch {
          /* clipboard blocked */
        }
      }}
    >
      {copied ? "✓ Copied" : `📋 Copy ${label}`}
    </button>
  );
}

interface ListingCardProps {
  group: ItemGroup;
  photoById: (id: string) => Photo | undefined;
  ebayConnected: boolean;
  onGroupEdit: (id: string, patch: Partial<ItemGroup>) => void;
  onEdit: (groupId: string, patch: Partial<ListingResult>) => void;
  onRenameSku: (groupId: string, sku: string) => void;
  onRetry: (groupId: string) => void;
  onPost: (groupId: string) => void;
}

export function ListingCard({
  group,
  photoById,
  ebayConnected,
  onEdit,
  onGroupEdit,
  onRenameSku,
  onRetry,
  onPost,
}: ListingCardProps) {
  const [open, setOpen] = useState(true);
  const listing = group.listing;
  const cover = photoById(group.photoIds[0]);

  const specifics = useMemo(() => {
    const entries = Object.entries(listing?.item_specifics ?? {});
    return entries.filter(
      ([k, v]) => v && String(v).trim() !== "" && !k.startsWith("---"),
    );
  }, [listing?.item_specifics]);

  const titleLen = listing?.title?.length ?? 0;

  // eBay's size standardization blocks apparel/footwear listings that are
  // missing a Size, so flag those for the seller before they post.
  const sizeRequired = SIZE_REQUIRED_CATEGORIES.has(listing?.category ?? "");
  const sizeMissing = sizeRequired && !(listing?.size ?? "").trim();

  return (
    <article className={`listing-card status-${group.status}`}>
      <header className="listing-card-head" onClick={() => setOpen((o) => !o)}>
        {cover && (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="listing-cover" src={cover.previewUrl} alt="" />
        )}
        <div className="listing-card-title">
          <strong>
            {group.sku && <span className="sku-tag">{group.sku}</span>}
            {listing?.title || group.name}
          </strong>
          <span className="listing-card-sub">
            {group.status === "writing" && (
              <>
                <span className="spinner small" aria-hidden="true" /> Writing…
              </>
            )}
            {group.status === "done" && (
              <>
                {draftIssues(group).length ? "needs review" : "ready"}
              </>
            )}
            {group.status === "error" && (
              <span style={{ color: "var(--color-danger)" }}>
                ⚠️ {group.error || "Failed"}
              </span>
            )}
            {group.status === "idle" && "Waiting…"}
          </span>
        </div>
        {group.status === "error" ? (
          <button
            type="button"
            className="btn-ghost"
            onClick={(e) => {
              e.stopPropagation();
              onRetry(group.id);
            }}
          >
            ↻ Retry
          </button>
        ) : (
          <span className="chevron" aria-hidden="true">
            {open ? "▾" : "▸"}
          </span>
        )}
      </header>

      {open && listing && group.status === "done" && (
        <fieldset
          className="listing-card-body"
          disabled={
            group.postStatus === "posted" || group.postStatus === "posting"
          }
        >
          <div className="result-field">
            <label>
              Title
              <span className={`count${titleLen > TITLE_LIMIT ? " over" : ""}`}>
                {titleLen}/{TITLE_LIMIT}
              </span>
            </label>
            <input
              type="text"
              className="title-input"
              value={listing.title}
              onChange={(e) => onEdit(group.id, { title: e.target.value })}
            />
            <div className="copy-row">
              <CopyButton text={listing.title} label="title" />
            </div>
          </div>

          <div className="meta-row">
            <div className="stat editable">
              <label className="k" htmlFor={`sku-${group.id}`}>
                SKU
              </label>
              <input
                id={`sku-${group.id}`}
                type="text"
                className="size-input"
                value={group.sku}
                disabled={group.postStatus === "posted"}
                onChange={(e) => onRenameSku(group.id, e.target.value)}
              />
            </div>
            
            {/* Condition Dropdown replaces the old Price field */}
            <div className="stat editable">
              <label className="k" htmlFor={`cond-${group.id}`}>
                Condition
              </label>
              <select
                id={`cond-${group.id}`}
                value={listing.condition ?? "GOOD"}
                onChange={(e) =>
                  onEdit(group.id, {
                    condition: e.target.value,
                    ebay_condition: "",
                  })
                }
              >
                {listing.condition &&
                  !CONDITIONS.some((c) => c.value === listing.condition) && (
                    <option value={listing.condition}>
                      {listing.condition.replace(/_/g, " ")}
                    </option>
                  )}
                {CONDITIONS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>

            {listing.brand && (
              <div className="stat">
                <div className="k">Brand</div>
                <div className="v">{listing.brand}</div>
              </div>
            )}
            {(sizeRequired || listing.size) && (
              <div
                className={`stat editable${sizeMissing ? " needs-attention" : ""}`}
              >
                <label className="k" htmlFor={`size-${group.id}`}>
                  Size
                </label>
                <input
                  id={`size-${group.id}`}
                  type="text"
                  className="size-input"
                  value={listing.size ?? ""}
                  placeholder={sizeRequired ? "e.g. M, 32x34, 10.5" : "—"}
                  onChange={(e) => onEdit(group.id, { size: e.target.value })}
                />
              </div>
            )}
          </div>

          {sizeMissing && (
            <p className="size-warning" role="alert">
              ⚠️ No size found on the tag. eBay now blocks apparel listings
              without a standard size — check the photos or measure the item,
              then fill in Size above before posting.
            </p>
          )}

          <div className="result-field">
            <label>Description</label>
            <textarea
              value={listing.description}
              onChange={(e) =>
                onEdit(group.id, { description: e.target.value })
              }
              rows={8}
            />
            <div className="copy-row">
              <CopyButton text={listing.description} label="description" />
            </div>
          </div>

          <button type="button" onClick={() => onRetry(group.id)}>
            Re-analyze selected photos (replaces this draft)
          </button>
          <DraftControls
            group={group}
            photoById={photoById}
            onGroupEdit={onGroupEdit}
          />
          {/* eBay posting */}
          {group.postStatus === "posted" ? (
            <>
              <p className="post-result ok">
                ✅ Saved as eBay Draft
                {group.listingId ? (
                  <>
                    {" "}
                    ·{" "}
                    <a
                      href={`https://www.ebay.com/sh/lst/drafts`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View drafts ↗
                    </a>
                  </>
                ) : null}
              </p>
              {(group.postWarnings ?? []).map((w) => (
                <p className="post-result warn" key={w}>
                  ⚠️ {w}
                </p>
              ))}
            </>
          ) : ebayConnected ? (
            <div className="post-row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => onPost(group.id)}
                disabled={
                  group.postStatus === "posting" ||
                  draftIssues(group).length > 0
                }
              >
                {group.postStatus === "posting" ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> Sending to
                    Drafts…
                  </>
                ) : (
                  "🚀 Send to eBay Drafts"
                )}
              </button>
              {group.postStatus === "error" && group.postError && (
                <p className="post-result err">⚠️ {group.postError}</p>
              )}
            </div>
          ) : (
            <p className="post-hint">
              Connect eBay (top of page) to save this draft.
            </p>
          )}
        </fieldset>
      )}
    </article>
  );
}
