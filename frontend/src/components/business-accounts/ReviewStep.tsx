"use client";

import {
  ReviewSection,
  formatShipmentType,
  getDocumentLabel,
  type ExistingDocuments
} from "@/components/business-accounts/FormFieldControls";
import InfoTooltip from "@/components/ui/InfoTooltip";
import { reviewTooltips } from "@/lib/businessAccountTooltips";
import { BusinessAccountFiles, BusinessAccountFormData, DocumentType } from "@/lib/businessAccounts";
import Link from "next/link";

// Review step UI for summarizing collected data before submission.
export function ReviewStep({
  formData,
  documentFields,
  existingDocuments,
  files,
  confirmation,
  validationErrors,
  onConfirmationChange,
  onEditStep,
  operatorName
}: {
  formData: BusinessAccountFormData;
  documentFields: { type: DocumentType; required: boolean; helper: string }[];
  existingDocuments: ExistingDocuments;
  files: BusinessAccountFiles;
  confirmation: boolean;
  validationErrors: Record<string, string>;
  onConfirmationChange: (checked: boolean) => void;
  onEditStep: (step: number) => void;
  operatorName?: string;
}) {
  return (
    <div className="space-y-6">
      <ReviewSection
        title="Contact Details"
        values={[
          ["Name", `${formData.contact.title} ${formData.contact.firstName} ${formData.contact.lastName}`],
          ["Email", formData.contact.email],
          ["Phone", `${formData.contact.mobileType} - ${formData.contact.countryCode} ${formData.contact.mobileNumber}`],
          ["Job Title", formData.contact.jobTitle],
          ["Department", formData.contact.department],
          ["Shipment Type", formData.contact.shipmentTypes.map(formatShipmentType).join(", ")]
        ]}
        onEdit={() => onEditStep(0)}
      />
      <ReviewSection
        title="Company Details"
        values={[
          ["Company", formData.company.companyName],
          ["Registration", `${formData.company.registrationCountry} - ${formData.company.registrationId}`],
          ["GSTIN", formData.company.gstExempt
            ? `GST exempt / not registered - ${formData.company.gstExemptReason || "no reason given"} (needs administrator approval)`
            : formData.company.gstin || "Not provided"],
          ["Shipment billing", formData.gstBilling.requestedTreatment === "NO_GST"
            ? `No GST requested - ${formData.gstBilling.requestReason}`
            : "GST applicable"],
          ["Operating Countries", formData.company.operatingCountries.join(", ")],
          ["Address", [
            formData.company.registeredAddress,
            formData.company.addressLine2,
            formData.company.city,
            formData.company.stateOrProvince,
            formData.company.postalCode
          ].filter(Boolean).join(", ")],
          ["Billing Address", formData.company.useCompanyAddressAsBillingAddress
            ? "Same as company address"
            : [
              formData.company.billingAddress?.addressLine1,
              formData.company.billingAddress?.addressLine2,
              formData.company.billingAddress?.city,
              formData.company.billingAddress?.stateOrProvince,
              formData.company.billingAddress?.postalCode,
              formData.company.billingAddress?.country
            ].filter(Boolean).join(", ")],
          ["Industry", formData.company.industry],
          ["Credit Requested", formData.company.requestedCreditLimit ? `${formData.company.requestedCreditCurrency} ${formData.company.requestedCreditLimit}` : "Not requested"]
        ]}
        onEdit={() => onEditStep(1)}
      />
      <ReviewSection
        title="Uploaded Documents"
        values={documentFields.map((field) => [
          getDocumentLabel(field.type),
          files[field.type]?.name || existingDocuments[field.type]?.originalName || (field.required ? "Missing" : "Not uploaded")
        ])}
        onEdit={() => onEditStep(2)}
      />
      <div className="flex items-start gap-3">
        <input
          id="business-account-confirmation"
          type="checkbox"
          checked={confirmation}
          onChange={(event) => onConfirmationChange(event.target.checked)}
          className="mt-1 h-4 w-4"
        />
        <label htmlFor="business-account-confirmation" className="text-sm font-medium leading-6 text-slate-700">
          {operatorName ? (
            `I confirm that the details and documents for this business account have been reviewed for ${operatorName}.`
          ) : (
            <>
              I understand and acknowledge that by requesting a Swiftline business
              account, I have also read, understood and accepted Swiftline&apos;s{" "}
              <Link href="/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                Terms of Use
              </Link>
              ,{" "}
              <Link href="/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                Privacy Notice
              </Link>{" "}
              and{" "}
              <Link href="/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                Data Privacy Policy
              </Link>
              .
            </>
          )}
        </label>
      </div>
      <p className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
        {operatorName ? "What happens after you save" : "What happens after you submit"}
        <InfoTooltip text={operatorName ? "The account is saved as a draft in this operator workspace." : reviewTooltips.confirmation} />
      </p>
      {validationErrors.confirmation ? <p className="text-xs font-semibold text-red-600">{validationErrors.confirmation}</p> : null}
    </div>
  );
}
