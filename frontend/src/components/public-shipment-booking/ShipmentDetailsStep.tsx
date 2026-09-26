import type {
  PublicParcel,
  PublicShipmentFormData,
} from "@/lib/publicShipmentBooking";
import { BookingField, BookingSelect } from "./BookingField";
import { ParcelItemsEditor } from "@/components/shipments/ParcelItemsEditor";
import type { ParcelItem } from "@/lib/parcelItems";
import { maxParcelItems } from "@/lib/parcelItems";
import { maxParcelsPerShipment } from "@/lib/shipmentLimits";
import { CsbVBookingFields } from "@/components/shipments/CsbVBookingFields";
import { getCsbVBookingIssues } from "@/lib/csbVBooking";

export const KYC_DOCUMENTS = [
  ["iec", "IEC"],
  ["gst", "GST certificate"],
  ["pan", "PAN card"],
  ["aadhaar", "Aadhaar card"],
  ["salePurchaseAdCode", "Sale / Purchase / AD Code"],
  ["lut", "LUT"],
  ["declarationOfGoods", "Declaration of goods"],
  ["hsnCode", "HSN code document"],
  ["other", "Other document"],
] as const;

export type SelectedKycFiles = Record<string, File | undefined>;
export type KycDocumentLabels = Record<string, string>;

function emptyItem() {
  return {
    description: "",
    hsnCode: "",
    unitType: "Pcs" as const,
    quantity: 1,
    unitRate: 0,
  };
}

function toEditorItems(items: PublicParcel["items"]): ParcelItem[] {
  return items.map((item) => ({
    description: item.description,
    hsnCode: item.hsnCode,
    unitType: item.unitType,
    quantity: item.quantity ? String(item.quantity) : "",
    unitRate: item.unitRate ? String(item.unitRate) : "",
  }));
}

function fromEditorItems(items: ParcelItem[]): PublicParcel["items"] {
  return items.map((item) => ({
    description: item.description,
    hsnCode: item.hsnCode,
    unitType: item.unitType as PublicParcel["items"][number]["unitType"],
    quantity: Number(item.quantity) || 0,
    unitRate: Number(item.unitRate) || 0,
  }));
}

export function emptyParcel(reference = ""): PublicParcel {
  return {
    weightKg: 0,
    lengthCm: 0,
    widthCm: 0,
    heightCm: 0,
    shipmentContentType: "PARCEL",
    shipmentReference1: reference,
    shipmentReference2: "",
    items: [emptyItem()],
  };
}

function FileChecklist({
  csbType,
  scope,
  files,
  labels,
  onFile,
  onLabel,
}: {
  csbType: PublicShipmentFormData["csbType"];
  scope: string;
  files: SelectedKycFiles;
  labels: KycDocumentLabels;
  onFile: (key: string, file?: File) => void;
  onLabel: (key: string, value: string) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {KYC_DOCUMENTS.map(([type, label]) => {
        const key = `${scope}:${type}`;
        const required = csbType === "CSB_V" && type !== "other";
        return (
          <div
            key={key}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
          >
            <label className="flex min-h-11 items-center justify-between gap-3">
              <span className="min-w-0 font-medium text-slate-600">
                {label}
                {required ? <span className="ml-1 text-red-600">*</span> : null}
              </span>
              <span className="min-w-0 max-w-[58%] sm:max-w-36">
                <input
                  className="sr-only"
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png"
                  onChange={(event) => onFile(key, event.target.files?.[0])}
                />
                <span
                  className={`block min-w-0 max-w-full overflow-hidden rounded-md border px-2.5 py-1 text-xs font-semibold ${files[key] ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-slate-300 bg-slate-50 text-slate-600"}`}
                >
                  <span className="block truncate" title={files[key]?.name}>
                    {files[key]?.name || "Choose file"}
                  </span>
                </span>
              </span>
            </label>
            {type === "other" && files[key] ? (
              <BookingField
                label="Document name"
                required
                value={labels[key] || ""}
                onChange={(event) => onLabel(key, event.target.value)}
                placeholder="For example, export licence"
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ParcelEditor({
  parcel,
  index,
  serviceType,
  csbType,
  errors,
  revealErrors,
  onChange,
  onRemove,
}: {
  parcel: PublicParcel;
  index: number;
  serviceType: "COURIER" | "CARGO";
  csbType: "CSB_IV" | "CSB_V";
  errors: Record<string, string>;
  revealErrors: boolean;
  onChange: (parcel: PublicParcel) => void;
  onRemove?: () => void;
}) {
  const divisor = serviceType === "CARGO" ? 6000 : 5000;
  const volumetric =
    parcel.lengthCm && parcel.widthCm && parcel.heightCm
      ? (parcel.lengthCm * parcel.widthCm * parcel.heightCm) / divisor
      : 0;
  const updateNumber = (key: keyof PublicParcel, value: string) =>
    onChange({ ...parcel, [key]: Number(value) || 0 });
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#0D1282]">
            Parcel {index + 1}
          </p>
          <h3 className="mt-1 font-bold text-slate-950">
            Dimensions and contents
          </h3>
        </div>
        {onRemove ? (
          <button
            type="button"
            onClick={onRemove}
            className="text-xs font-semibold text-red-600 hover:underline"
          >
            Remove
          </button>
        ) : null}
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <BookingField
          label="Actual weight (kg)"
          required
          type="number"
          min="0.01"
          max="1000"
          step="0.01"
          value={parcel.weightKg || ""}
          revealError={revealErrors}
          error={errors[`parcels.${index}.weightKg`]}
          onChange={(event) => updateNumber("weightKg", event.target.value)}
        />
        <BookingField
          label="Length (cm)"
          required
          type="number"
          min="0.1"
          max="1000"
          step="0.1"
          value={parcel.lengthCm || ""}
          revealError={revealErrors}
          error={errors[`parcels.${index}.lengthCm`]}
          onChange={(event) => updateNumber("lengthCm", event.target.value)}
        />
        <BookingField
          label="Width (cm)"
          required
          type="number"
          min="0.1"
          max="1000"
          step="0.1"
          value={parcel.widthCm || ""}
          revealError={revealErrors}
          error={errors[`parcels.${index}.widthCm`]}
          onChange={(event) => updateNumber("widthCm", event.target.value)}
        />
        <BookingField
          label="Height (cm)"
          required
          type="number"
          min="0.1"
          max="1000"
          step="0.1"
          value={parcel.heightCm || ""}
          revealError={revealErrors}
          error={errors[`parcels.${index}.heightCm`]}
          onChange={(event) => updateNumber("heightCm", event.target.value)}
        />
        <BookingSelect
          label="Contents type"
          required
          value={parcel.shipmentContentType}
          onChange={(event) =>
            onChange({
              ...parcel,
              shipmentContentType: event.target
                .value as PublicParcel["shipmentContentType"],
            })
          }
        >
          <option value="DOCUMENTS">Documents</option>
          <option value="PARCEL">Parcel</option>
          <option value="MERCHANDISE">Merchandise</option>
          <option value="SAMPLES">Samples</option>
          <option value="GIFTS">Gifts</option>
          <option value="RETURNS">Returns</option>
          <option value="OTHER">Other</option>
        </BookingSelect>
        <BookingField
          label="Your reference"
          required
          value={parcel.shipmentReference1}
          revealError={revealErrors}
          error={errors[`parcels.${index}.shipmentReference1`]}
          onChange={(event) =>
            onChange({
              ...parcel,
              shipmentReference1: event.target.value.toUpperCase(),
            })
          }
          placeholder="ORDER-1001"
        />
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 sm:col-span-2">
          <span className="text-xs font-medium text-slate-500">
            Weight used for pricing
          </span>
          <p className="mt-1 text-sm font-bold text-slate-900">
            {Math.max(parcel.weightKg, volumetric).toFixed(2)} kg{" "}
            <span className="font-normal text-slate-500">
              ({volumetric.toFixed(2)} kg volumetric)
            </span>
          </p>
        </div>
      </div>
      <div className="mt-5">
        <ParcelItemsEditor
          items={toEditorItems(parcel.items)}
          onChange={(items) => onChange({ ...parcel, items: fromEditorItems(items) })}
          parcelLabel={`Parcel ${index + 1}`}
          revealError={revealErrors}
          requireHsnCode={csbType === "CSB_V"}
          maxItems={maxParcelItems}
        />
      </div>
    </section>
  );
}

export default function ShipmentDetailsStep({
  data,
  onChange,
  files,
  labels,
  errors,
  revealErrors = false,
  onFile,
  onLabel,
  onOpenProhibited,
}: {
  data: PublicShipmentFormData;
  onChange: (data: PublicShipmentFormData) => void;
  files: SelectedKycFiles;
  labels: KycDocumentLabels;
  errors: Record<string, string>;
  revealErrors?: boolean;
  onFile: (key: string, file?: File) => void;
  onLabel: (key: string, value: string) => void;
  onOpenProhibited: () => void;
}) {
  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <BookingSelect
            label="Service"
            value={data.serviceType}
            onChange={(event) =>
              onChange({
                ...data,
                serviceType: event.target
                  .value as PublicShipmentFormData["serviceType"],
              })
            }
          >
            <option value="COURIER">International courier</option>
            <option value="CARGO">International cargo</option>
          </BookingSelect>
          <BookingSelect
            label="Customs route"
            value={data.csbType}
            onChange={(event) =>
              onChange({
                ...data,
                csbType: event.target
                  .value as PublicShipmentFormData["csbType"],
              })
            }
          >
            <option value="CSB_IV">CSB-IV</option>
            <option value="CSB_V">CSB-V</option>
          </BookingSelect>
          <div className="flex items-end sm:col-span-2">
            <button
              type="button"
              onClick={onOpenProhibited}
              className="h-11 text-sm font-bold text-[#0D1282] underline decoration-slate-300 underline-offset-4 hover:decoration-[#0D1282]"
            >
              View prohibited and restricted items
            </button>
          </div>
        </div>
        <p className="mt-4 text-xs leading-5 text-slate-500">
          CSB-V requires the complete customs document checklist and an HS code
          for every declared item. Insurance is not offered in this online
          booking release.
        </p>
        {data.csbType === "CSB_V" ? (
          <div className="mt-4">
            <CsbVBookingFields
              value={{ gstin: data.csbVGstin, accountNumber: data.csbVAccountNumber, invoiceNumber: data.csbVInvoiceNumber }}
              onChange={(next) => onChange({ ...data, csbVGstin: next.gstin, csbVAccountNumber: next.accountNumber, csbVInvoiceNumber: next.invoiceNumber })}
              issues={getCsbVBookingIssues({ gstin: data.csbVGstin, accountNumber: data.csbVAccountNumber, invoiceNumber: data.csbVInvoiceNumber }, data.csbType)}
              revealError={revealErrors}
            />
          </div>
        ) : null}
      </section>
      {data.parcels.map((parcel, index) => (
        <ParcelEditor
          key={index}
          parcel={parcel}
          index={index}
          serviceType={data.serviceType}
          csbType={data.csbType}
          errors={errors}
          revealErrors={revealErrors}
          onChange={(next) =>
            onChange({
              ...data,
              parcels: data.parcels.map((row, rowIndex) =>
                rowIndex === index ? next : row,
              ),
            })
          }
          onRemove={
            data.parcels.length > 1
              ? () =>
                  onChange({
                    ...data,
                    parcels: data.parcels.filter(
                      (_, rowIndex) => rowIndex !== index,
                    ),
                  })
              : undefined
          }
        />
      ))}
      {data.parcels.length < maxParcelsPerShipment ? (
        <button
          type="button"
          onClick={() =>
            onChange({
              ...data,
              parcels: [
                ...data.parcels,
                emptyParcel(`WEB-${data.parcels.length + 1}`),
              ],
            })
          }
          className="h-11 rounded-lg border border-[#0D1282] bg-white px-4 text-sm font-bold text-[#0D1282] hover:bg-[#0D1282]/5"
        >
          + Add another parcel
        </button>
      ) : null}
      <section className="rounded-xl border border-slate-200 bg-slate-50 p-5 sm:p-6">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
          <div>
            <h3 className="font-bold text-slate-950">Sender KYC documents</h3>
            <p className="mt-1 text-sm text-slate-600">
              PDF, JPG or PNG, up to 5 MB each. CSB-IV uploads are optional;
              CSB-V marked files are required.
            </p>
          </div>
          {data.parcels.length > 1 ? (
            <label className="flex items-center gap-2 text-sm font-semibold text-slate-600">
              <input
                type="checkbox"
                checked={data.kycUseForAllParcels}
                onChange={(event) =>
                  onChange({
                    ...data,
                    kycUseForAllParcels: event.target.checked,
                  })
                }
                className="h-4 w-4 accent-[#0D1282]"
              />
              Use the same KYC for every parcel
            </label>
          ) : null}
        </div>
        <div className="mt-5 space-y-5">
          {data.kycUseForAllParcels ? (
            <FileChecklist
              csbType={data.csbType}
              scope="shared"
              files={files}
              labels={labels}
              onFile={onFile}
              onLabel={onLabel}
            />
          ) : (
            data.parcels.map((_, index) => (
              <div key={index}>
                <p className="mb-2 text-sm font-bold text-slate-800">
                  Parcel {index + 1}
                </p>
                <FileChecklist
                  csbType={data.csbType}
                  scope={`parcel-${index + 1}`}
                  files={files}
                  labels={labels}
                  onFile={onFile}
                  onLabel={onLabel}
                />
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
