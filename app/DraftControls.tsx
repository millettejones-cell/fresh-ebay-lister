"use client";
import { useState, useRef, useEffect } from "react";
import type { ItemGroup, Photo } from "@/lib/types";
import type { AccountOptions } from "@/lib/ebay/publish";
import { applyShippingDefaults } from "@/lib/shipping-defaults";
import { requestText } from "@/lib/text-dialog";
import { loadAccountOptions } from "@/lib/account-options-client";
import { apiPost } from "@/lib/api-client";
import { draftIssues } from "@/lib/client-review";
import { isStandardSizeAspect } from "@/lib/ebay/aspects";

interface Props {
  group: ItemGroup;
  photoById: (id: string) => Photo | undefined;
  onGroupEdit: (id: string, patch: Partial<ItemGroup>) => void;
}

export function DraftControls({ group: g, photoById, onGroupEdit }: Props) {
  const [busy, setBusy] = useState(false);
  const [options, setOptions] = useState<AccountOptions>();
  const [error, setError] = useState("");
  const latest = useRef(g);
  latest.current = g;
  const defaultsRequested = useRef(false);

  // We keep this running silently in the background so the draft payload 
  // has policies attached to satisfy eBay's servers, even though they are hidden from you.
  useEffect(() => {
    if (g.listing && !defaultsRequested.current) {
      defaultsRequested.current = true;
      void loadOptions();
    }
  }, [Boolean(g.listing)]);

  if (!g.listing) return null;
  const l = g.listing;

  const edit = (patch: Partial<typeof l>) => {
    const next = { ...l, ...patch };
    if (patch.item_specifics) {
      for (const [key, field] of [
        ["Brand", "brand"],
        ["Size", "size"],
        ["Material", "material"],
        ["Type", "item_type"],
      ] as const)
        if (key in patch.item_specifics)
          next[field] = patch.item_specifics[key];
      next.evidence = {};
      next.estimates = Object.fromEntries(
        Object.entries(l.estimates ?? {}).filter(
          ([k]) =>
            !(k in patch.item_specifics!) ||
            patch.item_specifics![k] === l.item_specifics?.[k],
        ),
      );
    }
    onGroupEdit(g.id, {
      listing: next,
      compsStatus: "stale",
      comps: undefined,
    });
  };

  const specifics = l.item_specifics ?? {};
  const missingLevel = (name: string): "required" | "recommended" | "" => {
    if ((specifics[name] ?? "").trim()) return "";
    const meta = g.preparation?.aspects.find((a) => a.name === name);
    if (meta?.required) return "required";
    return meta?.usage === "RECOMMENDED" ? "recommended" : "";
  };

  const rank = { required: 0, recommended: 1, "": 2 };
const names = [
    ...new Set([
      ...(g.preparation?.aspects ?? [])
        .filter((a) => a.required) // We removed `|| a.usage === "RECOMMENDED"` here!
        .map((a) => a.name),
      ...Object.keys(specifics),
    ]),
  ].sort((a, b) => rank[missingLevel(a)] - rank[missingLevel(b)]);

  const missingRequired = names.filter((n) => missingLevel(n) === "required");
  const missingRecommended = names.filter(
    (n) => missingLevel(n) === "recommended",
  );

  async function prepare() {
    setBusy(true);
    setError("");
    try {
      const images = (g.analysisPhotoIds ?? g.photoIds)
        .map(photoById)
        .filter((p): p is Photo => Boolean(p) && p!.analysisSelected !== false)
        .map((p) => ({ mediaType: p.mediaType, data: p.data }));
      const r = await apiPost("/api/ebay/prepare", {
        listing: l,
        images,
        enrich: !g.preparation,
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error);
      if (latest.current.listing !== l)
        throw new Error(
          "The draft changed while preparing. Prepare it again to keep your edits.",
        );
      onGroupEdit(g.id, {
        listing: d.listing,
        preparation: d.preparation,
        preparationError: undefined,
        usage: [...(g.usage ?? []), ...(d.usage ?? [])],
        comps: undefined,
        compsStatus: "stale",
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function loadOptions(refresh = false) {
    setBusy(true);
    setError("");
    try {
      const options = await loadAccountOptions(refresh);
      setOptions(options);
      const current = latest.current;
      const shipping = applyShippingDefaults(current.shipping ?? {}, options);
      if (JSON.stringify(shipping) !== JSON.stringify(current.shipping ?? {}))
        onGroupEdit(g.id, { shipping });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <fieldset
      disabled={busy || g.postStatus === "posted" || g.postStatus === "posting"}
      className="draft-controls"
    >
      <legend>Review eBay details</legend>
      <label>
        Clothing department
        <select
          aria-label="Clothing department"
          value={
            l.category?.startsWith("womens_")
              ? "Women"
              : l.category?.startsWith("mens_")
                ? "Men"
                : ""
          }
          onChange={(e) => {
            const family = (l.category || "clothing").replace(
              /^(womens|mens)_/,
              "",
            );
            edit({
              category: e.target.value
                ? (e.target.value === "Women" ? "womens_" : "mens_") + family
                : "accessory",
              category_id: "",
              ebay_condition: "",
              item_specifics: { ...specifics, Department: e.target.value },
            });
          }}
        >
          <option value="">Not established / other</option>
          <option>Women</option>
          <option>Men</option>
        </select>
      </label>
      {!!g.preparation?.suggestions?.length && (
        <label>
          Suggested category
          <select
            value={l.category_id || ""}
            onChange={(e) =>
              edit({ category_id: e.target.value, ebay_condition: "" })
            }
          >
            {g.preparation.suggestions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.path}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Category ID{" "}
        <input
          aria-label="Category ID"
          value={l.category_id ?? ""}
          onChange={(e) =>
            edit({ category_id: e.target.value, ebay_condition: "" })
          }
        />
      </label>
      <button type="button" onClick={prepare}>
        {busy ? "Working…" : "Prepare category and specifics"}
      </button>
      {g.preparation && <p>{g.preparation.categoryName}</p>}
      {(error || g.preparationError) && (
        <p role="alert">{error || g.preparationError}</p>
      )}
      {g.preparation && (
        <label>
          eBay condition{" "}
          <select
            aria-label="eBay condition"
            value={l.ebay_condition ?? ""}
            onChange={(e) =>
              edit({
                ebay_condition: e.target.value,
                condition:
                  e.target.value === "NEW_WITH_DEFECTS"
                    ? "NEW_WITH_DEFECTS"
                    : e.target.value.startsWith("NEW")
                      ? "NEW_WITH_TAGS"
                      : e.target.value === "FOR_PARTS_OR_NOT_WORKING"
                        ? "FOR_PARTS_OR_NOT_WORKING"
                        : "GOOD",
              })
            }
          >
            <option value="">Choose condition</option>
            {g.preparation.conditions.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Condition / testing notes
        <textarea
          value={l.condition_notes ?? ""}
          onChange={(e) => edit({ condition_notes: e.target.value })}
        />
      </label>
      <details open>
        <summary>
          Editable item specifics — AI estimates are marked; check them before posting
        </summary>
        {(missingRequired.length > 0 || missingRecommended.length > 0) && (
          <p className="specifics-missing-summary">
            {missingRequired.length > 0 && (
              <span className="missing-required">
                Required, still empty: {missingRequired.join(", ")}.
              </span>
            )}{" "}
            {missingRecommended.length > 0 && (
              <span className="missing-recommended">
                Recommended, still empty: {missingRecommended.join(", ")}.
              </span>
            )}
          </p>
        )}
        {names.map((name) => {
          const meta = g.preparation?.aspects.find((a) => a.name === name);
          const missing = missingLevel(name);
          return (
            <label
              key={name}
              className={`specific-edit${missing ? ` specific-missing-${missing}` : ""}`}
            >
              <span className="specific-head">
                <span className="specific-name">
                  {name}
                  {meta?.required ? " *" : ""}
                </span>
                {missing && (
                  <span className="missing-tag">
                    {missing === "required"
                      ? " · Required — missing"
                      : " · Recommended — missing"}
                  </span>
                )}
                {l.evidence?.[name]?.length
                  ? ` (AI cites photo ${l.evidence[name]
                      .map((n) => {
                        const id = g.evidencePhotoIds?.[n - 1];
                        return id ? g.photoIds.indexOf(id) + 1 : n;
                      })
                      .join(", ")}; verify)`
                  : ""}
                {l.estimates?.[name] ? (
                  <span className="estimate-tag">
                    {" "}
                    AI estimate · {l.estimates[name]}% sure
                  </span>
                ) : null}
              </span>
              {meta &&
              (meta.mode === "SELECTION_ONLY" || isStandardSizeAspect(meta)) &&
              meta.cardinality !== "MULTI" ? (
                <select
                  aria-label={name}
                  value={specifics[name] ?? ""}
                  onChange={(e) =>
                    edit({
                      item_specifics: { ...specifics, [name]: e.target.value },
                    })
                  }
                >
                  <option value="">Unknown — leave empty</option>
                  {meta.values.map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              ) : (
                <input
                  aria-label={name}
                  value={specifics[name] ?? ""}
                  placeholder={
                    meta?.cardinality === "MULTI"
                      ? "Separate multiple values with |"
                      : "Unknown — leave empty"
                  }
                  onChange={(e) =>
                    edit({
                      item_specifics: { ...specifics, [name]: e.target.value },
                    })
                  }
                />
              )}
            </label>
          );
        })}
        <button
          type="button"
          onClick={async () => {
            const name = await requestText("Specific name, such as Model");
            if (name?.trim())
              edit({ item_specifics: { ...specifics, [name.trim()]: "" } });
          }}
        >
          Add a specific
        </button>
      </details>
      <details>
        <summary>Photos and analysis evidence ({g.photoIds.length})</summary>
        <p>
          All item photos publish. Choose which photos the AI reads; include
          labels and defects. Originals are saved on this device.
        </p>
        {g.photoIds.map((id, i) => {
          const p = photoById(id);
          return p ? (
            <div key={id}>
              <label>
                <input
                  type="checkbox"
                  checked={(g.analysisPhotoIds ?? g.photoIds).includes(id)}
                  onChange={(e) =>
                    onGroupEdit(g.id, {
                      analysisPhotoIds: e.target.checked
                        ? [...(g.analysisPhotoIds ?? g.photoIds), id]
                        : (g.analysisPhotoIds ?? g.photoIds).filter(
                            (x) => x !== id,
                          ),
                    })
                  }
                />
                Use photo {i + 1} for analysis
              </label>
              <img src={p.previewUrl} width={80} alt={`Item photo ${i + 1}`} />
              {p.original && (
                <button
                  type="button"
                  onClick={() => {
                    const u = URL.createObjectURL(p.original!);
                    const a = document.createElement("a");
                    a.href = u;
                    a.download = `${g.sku}-${i + 1}-original`;
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(u), 1000);
                  }}
                >
                  Save original
                </button>
              )}
            </div>
          ) : null;
        })}
      </details>
      
      {/* Redesigned Dimensions block */}
      <details open>
        <summary>Package weight and dimensions (optional)</summary>
        <p className="note">
          Leave blank for flat-fee shipping. Quietly uses your default shipping policies in the background.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem", marginTop: "0.5rem" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: "4px", maxWidth: "150px" }}>
            <strong>Weight (oz)</strong>
            <input
              aria-label="Packed weight (oz)"
              type="number"
              min="0.01"
              step="0.01"
              value={g.shipping?.weightOz ?? ""}
              onChange={(e) =>
                onGroupEdit(g.id, {
                  shipping: {
                    ...g.shipping,
                    weightOz: e.target.value === "" ? undefined : Number(e.target.value),
                  },
                })
              }
            />
          </label>
          <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: "4px", flex: 1, minWidth: "80px", maxWidth: "120px" }}>
              <strong>Length (in)</strong>
              <input
                aria-label="Length (in)"
                type="number"
                min="0.01"
                step="0.01"
                value={g.shipping?.lengthIn ?? ""}
                onChange={(e) =>
                  onGroupEdit(g.id, {
                    shipping: {
                      ...g.shipping,
                      lengthIn: e.target.value === "" ? undefined : Number(e.target.value),
                    },
                  })
                }
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "4px", flex: 1, minWidth: "80px", maxWidth: "120px" }}>
              <strong>Width (in)</strong>
              <input
                aria-label="Width (in)"
                type="number"
                min="0.01"
                step="0.01"
                value={g.shipping?.widthIn ?? ""}
                onChange={(e) =>
                  onGroupEdit(g.id, {
                    shipping: {
                      ...g.shipping,
                      widthIn: e.target.value === "" ? undefined : Number(e.target.value),
                    },
                  })
                }
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "4px", flex: 1, minWidth: "80px", maxWidth: "120px" }}>
              <strong>Height (in)</strong>
              <input
                aria-label="Height (in)"
                type="number"
                min="0.01"
                step="0.01"
                value={g.shipping?.heightIn ?? ""}
                onChange={(e) =>
                  onGroupEdit(g.id, {
                    shipping: {
                      ...g.shipping,
                      heightIn: e.target.value === "" ? undefined : Number(e.target.value),
                    },
                  })
                }
              />
            </label>
          </div>
        </div>
      </details>

      {!!g.usage?.length && (
        <p>
          AI usage so far:{" "}
          {g.usage
            .reduce((n, u) => n + u.input + u.cacheRead + u.cacheWrite, 0)
            .toLocaleString()}{" "}
          input tokens ·{" "}
          {g.usage.reduce((n, u) => n + u.output, 0).toLocaleString()} output ·
          estimated $
          {g.usage.reduce((n, u) => n + (u.estimatedUsd ?? 0), 0).toFixed(4)}{" "}
          (recorded calls; bulk sorting separate).
        </p>
      )}
      {draftIssues(g).length > 0 && (
        <ul aria-label="Review issues">
          {draftIssues(g).map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
