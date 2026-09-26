"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  FiCheck,
  FiChevronDown,
  FiMinus,
  FiPlus,
  FiX,
} from "react-icons/fi";
import { toast } from "react-toastify";
import { ShipmentFieldLabel } from "@/components/shipments/ShipmentFormControls";
import {
  fetchHsCodeSuggestions,
  minHsCodeQueryLength,
  type HsCodeSuggestion,
} from "@/lib/hsCodes";
import {
  createEmptyParcelItem,
  getHsnCodeError,
  getParcelItemAmount,
  getParcelItemAmountError,
  getPositiveNumberError,
  maxParcelItems,
  sanitizeParcelItemDescription,
  parcelItemUnitTypeValues,
  type ParcelItem,
} from "@/lib/parcelItems";
import { findRestrictedCategories } from "@/lib/restrictedGoods";

/**
 * Per-parcel contents: one row per distinct good. Each row becomes a single line
 * on the customs (shipment) invoice, so it carries the HS code, unit of measure,
 * quantity and unit rate that document needs. Amount is derived (qty x rate) and
 * shown read-only so it can never disagree with its inputs.
 *
 * Restricted descriptions highlight red and raise a toast on blur. The joined
 * descriptions become the parcel's contentsDescription on save, which is what the
 * EDI export, manifest, carrier payload and labels keep reading.
 *
 * `requireHsnCode` follows the shipment's CSB type: CSB-V clears on the full
 * customs checklist and needs a code on every line, CSB-IV does not. A code that
 * IS entered is format-checked either way.
 */
export function ParcelItemsEditor({
  items,
  onChange,
  revealError = false,
  requireHsnCode = true,
  maxItems = maxParcelItems,
  parcelLabel = "Parcel",
}: {
  items: ParcelItem[];
  onChange: (items: ParcelItem[]) => void;
  revealError?: boolean;
  requireHsnCode?: boolean;
  maxItems?: number;
  parcelLabel?: string;
}) {
  // The description being typed drives the HS code suggestions below it. Only
  // the focused row looks anything up, so one lookup runs at a time.
  const [activeRow, setActiveRow] = useState<number | null>(null);

  // Results are kept with the query they answer, so anything the user has since
  // typed past simply stops being rendered rather than needing to be cleared.
  const [suggestions, setSuggestions] = useState<{
    query: string;
    results: HsCodeSuggestion[];
  }>({ query: "", results: [] });

  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const activeQuery =
    activeRow === null ? "" : (items[activeRow]?.description ?? "").trim();

  const visibleSuggestions =
    activeQuery && suggestions.query === activeQuery ? suggestions.results : [];

  useEffect(() => {
    if (activeQuery.length < minHsCodeQueryLength) return;

    // Debounced so a lookup follows the typing rather than every keystroke, and
    // cancelled on unmount so a late reply cannot land on a different row.
    let active = true;

    const timer = window.setTimeout(() => {
      void fetchHsCodeSuggestions(activeQuery).then((results) => {
        if (active) {
          setSuggestions({
            query: activeQuery,
            results,
          });
        }
      });
    }, 250);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [activeQuery]);

  function updateItem(
    index: number,
    field: keyof ParcelItem,
    value: string,
  ) {
    onChange(
      items.map((item, itemIndex) =>
        itemIndex === index ? { ...item, [field]: value } : item,
      ),
    );
  }

  function addItem() {
    if (items.length >= maxItems) return;

    onChange([...items, createEmptyParcelItem()]);
  }

  function removeItem(index: number) {
    // Always leave one row so the parcel never renders with no contents input.
    if (items.length <= 1) {
      onChange([createEmptyParcelItem()]);
      return;
    }

    onChange(items.filter((_, itemIndex) => itemIndex !== index));
  }

  const closeEditor = useCallback(() => {
    setIsOpen(false);

    window.setTimeout(() => {
      triggerRef.current?.focus();
    }, 0);
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    window.setTimeout(() => {
      closeRef.current?.focus();
    }, 0);

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeEditor();
        return;
      }

      if (event.key !== "Tab" || !dialogRef.current) return;

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
        ),
      );

      if (!focusable.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [closeEditor, isOpen]);

  const declaredTotal = items.reduce(
    (total, item) => total + getParcelItemAmount(item),
    0,
  );

  const enteredItems = items.filter(
    (item) => item.description.trim() || item.hsnCode.trim(),
  );

  const itemSummary = enteredItems.length
    ? enteredItems
        .slice(0, 3)
        .map((item) => item.description.trim() || "Unnamed item")
        .join(", ")
    : "No item details added yet.";

  return (
    <>
      <div
        className={`min-w-0 rounded-xl border p-3 ${
          revealError && !enteredItems.length
            ? "border-red-300 bg-red-50/50"
            : "border-slate-200 bg-slate-50/70"
        }`}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <ShipmentFieldLabel
              required
              tooltip="Each distinct item in this box, with its HS code, quantity and unit rate"
            >
              Contents
            </ShipmentFieldLabel>

            <p
              className="mt-1 truncate text-[13px] font-semibold text-slate-900"
              title={itemSummary}
            >
              {itemSummary}
            </p>

            <p
              className={`mt-1 text-xs ${
                revealError && !enteredItems.length
                  ? "font-semibold text-red-700"
                  : "text-slate-500"
              }`}
            >
              {enteredItems.length
                ? `${enteredItems.length} item${
                    enteredItems.length === 1 ? "" : "s"
                  }`
                : "Add the goods inside this parcel"}

              {enteredItems.length > 3 ? " · More items inside" : ""}
            </p>
          </div>

          <button
            ref={triggerRef}
            type="button"
            onClick={() => setIsOpen(true)}
            className="inline-flex h-10 shrink-0 items-center gap-2 rounded-xl border border-blue-900 bg-white px-3.5 text-xs font-semibold text-blue-900 transition hover:bg-blue-900 hover:text-white focus:outline-none focus:ring-2 focus:ring-blue-200"
            aria-haspopup="dialog"
          >
            <FiPlus aria-hidden="true" />
            {enteredItems.length ? "Edit items" : "Add items"}
          </button>
        </div>

        <div className="mt-3 flex items-center justify-between gap-3 border-t border-slate-200 pt-2 text-xs">
          <span className="font-semibold uppercase tracking-wide text-slate-500">
            Box declared value
          </span>

          <span className="font-semibold text-slate-900">
            {declaredTotal.toFixed(2)}
          </span>
        </div>
      </div>

      {isOpen && typeof document !== "undefined"
        ? createPortal(
            <div
              className="fixed inset-0 z-[200] flex items-end justify-center bg-slate-950/50 p-0 backdrop-blur-[1px] sm:items-center sm:p-4"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                  closeEditor();
                }
              }}
            >
              <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                className="flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-t-xl border border-slate-200 bg-white shadow-2xl sm:max-w-6xl sm:rounded"
              >
                <header className="flex shrink-0 items-center justify-between gap-4 border-b border-slate-200 px-4 py-3 sm:px-5">
                  <div className="min-w-0">
                    <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-blue-900">
                      {parcelLabel}
                    </p>

                    <h2
                      id={titleId}
                      className="text-base font-semibold tracking-tight text-slate-950 sm:text-lg"
                    >
                      Manage contents
                    </h2>
                  </div>

                     <div className="flex items-center gap-6">
                        <button
                      type="button"
                      onClick={addItem}
                      disabled={items.length >= maxItems}
                      className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-900 px-3 text-xs font-semibold text-white transition hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                    >
                      <FiPlus aria-hidden="true" className="h-3.5 w-3.5" />
                      Add item
                    </button>

                  <button
                    ref={closeRef}
                    type="button"
                    onClick={closeEditor}
                    aria-label="Close item editor"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-200"
                  >
                    <FiX aria-hidden="true" className="h-4 w-4" />
                  </button>
                     </div>
                </header>

                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3 [scrollbar-color:#94a3b8_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-400 sm:px-5 sm:py-4">
               

                  <div className="mt-3 space-y-2.5">
                    {items.map((item, index) => {
                      const restricted = findRestrictedCategories(
                        item.description,
                      );

                      const hsnError = getHsnCodeError(
                        item.hsnCode,
                        requireHsnCode,
                      );

                      const quantityError = getPositiveNumberError(
                        item.quantity,
                        "Quantity",
                      );

                      const unitRateError = getPositiveNumberError(
                        item.unitRate,
                        "Unit rate",
                      );

                      const amountError = getParcelItemAmountError(item);

                      const showDescriptionError = restricted.length > 0;

                      const showHsnError =
                        Boolean(hsnError) &&
                        (revealError || item.hsnCode.trim().length > 0);

                      const rowError = showDescriptionError
                        ? `${restricted.join(
                            ", ",
                          )} is a restricted item and cannot be shipped.`
                        : showHsnError
                          ? hsnError
                            : amountError
                              ? amountError
                              : revealError
                                ? quantityError || unitRateError
                                : "";

                      return (
                        <div
                          key={index}
                          className="rounded border border-slate-200 bg-white p-3"
                        >
                          <div className="mb-2.5 flex items-center justify-between gap-3">
                            <p className="text-xs font-semibold text-slate-500">
                              Item {index + 1}
                            </p>

                            <button
                              type="button"
                              onClick={() => removeItem(index)}
                              disabled={
                                items.length <= 1 &&
                                !item.description &&
                                !item.hsnCode
                              }
                              aria-label={`Remove item ${index + 1}`}
                              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 text-xs font-semibold text-red-600 transition hover:border-red-200 hover:bg-red-50 disabled:cursor-not-allowed disabled:text-red-700 disabled:hover:border-slate-200 disabled:hover:bg-transparent"
                            >
                              <FiMinus
                                aria-hidden="true"
                                className="h-3.5 w-3.5"
                              />
                              Remove
                            </button>
                          </div>

                          <div className="grid gap-2.5 lg:grid-cols-[minmax(0,2fr)_minmax(130px,1fr)_120px_100px_120px_120px]">
                            <div className="relative min-w-0">
                              <label
                                className="block text-xs font-semibold text-slate-600"
                                htmlFor={`${titleId}-description-${index}`}
                              >
                                Description
                              </label>

                              <input
                                id={`${titleId}-description-${index}`}
                                type="text"
                                value={item.description}
                                onChange={(event) =>
                                  updateItem(
                                    index,
                                    "description",
                                    sanitizeParcelItemDescription(
                                      event.target.value,
                                    ).toUpperCase(),
                                  )
                                }
                                onFocus={() => setActiveRow(index)}
                                onBlur={() => {
                                  setActiveRow((current) =>
                                    current === index ? null : current,
                                  );

                                  if (restricted.length) {
                                    toast.error(
                                      `${restricted.join(
                                        ", ",
                                      )} is a restricted item and cannot be shipped.`,
                                      {
                                        toastId: `restricted-${restricted.join(
                                          "-",
                                        )}`,
                                      },
                                    );
                                  }
                                }}
                                placeholder={`Item ${index + 1} description`}
                                title="Letters only - record quantities in the Qty and Unit Rate fields."
                                maxLength={120}
                                aria-invalid={showDescriptionError}
                                className={`mt-1 h-10 w-full rounded-lg border px-3 text-[13px] outline-none transition focus:ring-2 ${
                                  showDescriptionError ||
                                  (revealError && !item.description.trim())
                                    ? "border-red-400 bg-red-50 focus:border-red-500 focus:ring-red-100"
                                    : "border-slate-300 bg-white focus:border-blue-900 focus:ring-blue-100"
                                }`}
                              />

                              {activeRow === index &&
                              visibleSuggestions.length ? (
                                <ul className="absolute left-0 top-full z-10 mt-1 max-h-60 w-[min(30rem,85vw)] overflow-y-auto rounded-xl border border-slate-200 bg-white py-1 shadow-xl">
                                  <li className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                                    Suggested HS codes
                                  </li>

                                  {visibleSuggestions.map((suggestion) => (
                                    <li key={suggestion.code}>
                                      <button
                                        type="button"
                                        onMouseDown={(event) =>
                                          event.preventDefault()
                                        }
                                        onClick={() => {
                                          updateItem(
                                            index,
                                            "hsnCode",
                                            suggestion.code,
                                          );

                                          setSuggestions({
                                            query: "",
                                            results: [],
                                          });
                                        }}
                                        className="flex w-full items-start gap-2 px-3 py-2 text-left text-xs transition hover:bg-blue-50"
                                      >
                                        <span className="font-semibold text-blue-900">
                                          {suggestion.code}
                                        </span>

                                        <span className="text-slate-600">
                                          {suggestion.description}
                                        </span>
                                      </button>
                                    </li>
                                  ))}
                                </ul>
                              ) : null}
                            </div>

                            <label className="block text-xs font-semibold text-slate-600">
                              HS code
                              {requireHsnCode ? "" : " (optional)"}

                              <input
                                type="text"
                                inputMode="numeric"
                                value={item.hsnCode}
                                onChange={(event) =>
                                  updateItem(
                                    index,
                                    "hsnCode",
                                    event.target.value
                                      .replace(/\D/g, "")
                                      .slice(0, 10),
                                  )
                                }
                                onBlur={() => {
                                  if (hsnError && item.hsnCode.trim()) {
                                    toast.error(hsnError, {
                                      toastId: hsnError,
                                    });
                                  }
                                }}
                                placeholder={
                                  requireHsnCode ? "HS code" : "Optional"
                                }
                                aria-invalid={showHsnError}
                                className={`mt-1 h-10 w-full rounded-lg border px-3 text-[13px] outline-none transition focus:ring-2 ${
                                  showHsnError
                                    ? "border-red-400 bg-white focus:border-red-500 focus:ring-red-100"
                                    : "border-slate-300 bg-white focus:border-blue-900 focus:ring-blue-100"
                                }`}
                              />
                            </label>

                            <label className="block text-xs font-semibold text-slate-600">
                              Unit type

                              <div className="relative mt-1">
                                <select
                                  value={item.unitType}
                                  onChange={(event) =>
                                    updateItem(
                                      index,
                                      "unitType",
                                      event.target.value,
                                    )
                                  }
                                className="h-10 w-full appearance-none rounded-lg border border-slate-300 bg-white py-0 pl-3 pr-9 text-[13px] outline-none transition focus:border-blue-900 focus:ring-2 focus:ring-blue-100"
                                >
                                  {parcelItemUnitTypeValues.map((unit) => (
                                    <option key={unit} value={unit}>
                                      {unit}
                                    </option>
                                  ))}
                                </select>

                                <FiChevronDown
                                  aria-hidden="true"
                                  className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
                                />
                              </div>
                            </label>

                            <label className="block text-xs font-semibold text-slate-600">
                              Quantity

                              <input
                                type="number"
                                inputMode="numeric"
                                min="0"
                                step="1"
                                value={item.quantity}
                                onChange={(event) =>
                                  updateItem(
                                    index,
                                    "quantity",
                                    event.target.value,
                                  )
                                }
                                onBlur={() => {
                                  if (amountError) {
                                    toast.error(`${parcelLabel} item ${index + 1}: ${amountError}`, {
                                      toastId: `item-amount-${parcelLabel}-${index}`,
                                    });
                                  }
                                }}
                                placeholder="Qty"
                                aria-invalid={Boolean(
                                  revealError && quantityError,
                                )}
                                className={`mt-1 h-10 w-full rounded-lg border px-3 text-[13px] outline-none transition focus:ring-2 ${
                                  revealError && quantityError
                                    ? "border-red-400 bg-white focus:border-red-500 focus:ring-red-100"
                                    : "border-slate-300 bg-white focus:border-blue-900 focus:ring-blue-100"
                                }`}
                              />
                            </label>

                            <label className="block text-xs font-semibold text-slate-600">
                              Unit rate

                              <input
                                type="number"
                                inputMode="decimal"
                                min="0"
                                step="0.01"
                                value={item.unitRate}
                                onChange={(event) =>
                                  updateItem(
                                    index,
                                    "unitRate",
                                    event.target.value,
                                  )
                                }
                                onBlur={() => {
                                  if (amountError) {
                                    toast.error(`${parcelLabel} item ${index + 1}: ${amountError}`, {
                                      toastId: `item-amount-${parcelLabel}-${index}`,
                                    });
                                  }
                                }}
                                placeholder="Rate"
                                aria-invalid={Boolean(
                                  revealError && unitRateError,
                                )}
                                className={`mt-1 h-10 w-full rounded-lg border px-3 text-[13px] outline-none transition focus:ring-2 ${
                                  revealError && unitRateError
                                    ? "border-red-400 bg-white focus:border-red-500 focus:ring-red-100"
                                    : "border-slate-300 bg-white focus:border-blue-900 focus:ring-blue-100"
                                }`}
                              />
                            </label>

                            <div>
                              <span className="block text-xs font-semibold text-slate-600">
                                Amount
                              </span>

                              <div
                                aria-label={`Item ${index + 1} amount`}
                                aria-invalid={Boolean(amountError)}
                                className={`mt-1 flex h-10 items-center rounded-lg border px-3 text-[13px] font-semibold transition ${
                                  amountError
                                    ? "border-red-400 bg-red-50 text-red-700"
                                    : "border-slate-200 bg-slate-50 text-slate-700"
                                }`}
                              >
                                {getParcelItemAmount(item).toFixed(2)}
                              </div>
                            </div>
                          </div>

                          {rowError ? (
                            <p className="mt-2 text-xs font-semibold text-red-600">
                              {rowError}
                            </p>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>

                <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-slate-200 bg-slate-50/80 px-4 py-2.5 sm:px-5">
                  <span className="text-xs font-medium text-slate-500">
                    {items.length} / {maxItems} items
                    <span className="mx-2 text-slate-300">•</span>
                    Value{" "}
                    <span className="font-semibold text-slate-800">
                      {declaredTotal.toFixed(2)}
                    </span>
                  </span>

                  {/* <button
                    type="button"
                    onClick={closeEditor}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-900 px-4 text-xs font-semibold text-white transition hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-200"
                  >
                    Done
                  </button> */}
                </footer>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
