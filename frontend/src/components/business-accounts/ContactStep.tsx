"use client";

import { useState } from "react";
import {
  Field,
  SearchableSelect,
  CountryCodeField,
  type ContactUpdater,
  type FieldStatus,
  type UniqueField,
  departments,
  mobileTypeOptions,
  shipmentTypeOptions,
  titleOptions,
  toOptions
} from "@/components/business-accounts/FormFieldControls";
import { BusinessAccountFormData } from "@/lib/businessAccounts";
import { OTHER_JOB_TITLE, isListedJobTitle, jobTitleOptions } from "@/lib/businessAccountOptions";
import { contactTooltips } from "@/lib/businessAccountTooltips";

/**
 * Job title picker: a searchable list of the titles Swiftline recognises, with
 * an "Other" choice that reveals a free-text box.
 *
 * The server stores the title as free text, so a stored value that is not on
 * the list (an older record, or one typed through "Other") reopens in the text
 * box instead of being silently replaced by a listed title.
 */
function JobTitleField({
  value,
  error,
  status,
  onChange,
  onBlur
}: {
  value: string;
  error?: string;
  status: FieldStatus;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  const [otherPicked, setOtherPicked] = useState(false);
  const showsOther = otherPicked || (Boolean(value) && !isListedJobTitle(value));

  return (
    <div className="grid gap-3">
      <SearchableSelect
        label="Job Title"
        value={showsOther ? OTHER_JOB_TITLE : value}
        onChange={(next) => {
          if (next === OTHER_JOB_TITLE) {
            // Deliberately not marked as visited: the user has answered the
            // dropdown but not yet the box it just revealed, and greeting them
            // with "Job title is required" before they can type would be absurd.
            setOtherPicked(true);
            onChange("");
            return;
          }

          // Choosing from the list counts as answering the field, so the result
          // is judged immediately rather than waiting for a blur that a mouse
          // user may never produce.
          onBlur();
          setOtherPicked(false);
          onChange(next);
        }}
        options={jobTitleOptions}
        // While "Other" is active the message belongs on the text box the user
        // actually types into, not on the dropdown that already has a value.
        error={showsOther ? undefined : error}
        status={showsOther ? "idle" : status}
        info={contactTooltips.jobTitle}
        required
      />

      {showsOther ? (
        <Field
          label="Job Title (Manual Entry)"
          value={value}
          onChange={onChange}
          onBlur={onBlur}
          error={error}
          placeholder="e.g. Regional Logistics Head"
          maxLength={80}
          status={status}
          required
        />
      ) : null}
    </div>
  );
}

// Contact step UI for collecting personal and shipment details.
export function ContactStep({
  formData,
  validationErrors,
  fieldStatus,
  fieldErrors,
  validatingFields,
  onContactChange,
  onShipmentTypeChange,
  onValidateUniqueField,
  onFieldBlur,
  operatorDraftMode = false
}: {
  formData: BusinessAccountFormData;
  validationErrors: Record<string, string>;
  fieldStatus: Record<string, FieldStatus>;
  fieldErrors: Partial<Record<UniqueField, string>>;
  validatingFields: Partial<Record<UniqueField, boolean>>;
  onContactChange: ContactUpdater;
  onShipmentTypeChange: (value: string) => void;
  onValidateUniqueField: (field: UniqueField) => Promise<boolean>;
  onFieldBlur: (...keys: string[]) => void;
  /** Defer duplicate lookups until the operator explicitly saves the draft. */
  operatorDraftMode?: boolean;
}) {
  return (
    <div className="grid gap-6">
      <div className="grid gap-5 md:grid-cols-[minmax(110px,140px)_1fr_1fr]">
        <SearchableSelect
          label="Title"
          value={formData.contact.title}
          onChange={(value) => {
            onFieldBlur("title");
            onContactChange("title", value as BusinessAccountFormData["contact"]["title"]);
          }}
          options={titleOptions}
          error={validationErrors.title}
          status={fieldStatus.title}
          required
        />
        <Field
          label="First Name"
          value={formData.contact.firstName}
          onChange={(value) => onContactChange("firstName", value)}
          onBlur={() => onFieldBlur("firstName")}
          error={validationErrors.firstName}
          status={fieldStatus.firstName}
          maxLength={22}
          required
        />
        <Field
          label="Last Name"
          value={formData.contact.lastName}
          onChange={(value) => onContactChange("lastName", value)}
          onBlur={() => onFieldBlur("lastName")}
          error={validationErrors.lastName}
          status={fieldStatus.lastName}
          maxLength={22}
          required
        />
      </div>

      <div className="border border-yellow-300 bg-yellow-50 px-3 py-3 text-sm text-slate-900">
        Note: You can only enter up to <span className="font-bold">22 characters </span> in each &quot;First name&quot; and &quot;Last name&quot; field.
      </div>

      <Field
        label="Email Address"
        type="email"
        value={formData.contact.email}
        onChange={(value) => onContactChange("email", value)}
        onBlur={() => {
          onFieldBlur("email");
          if (!operatorDraftMode) void onValidateUniqueField("email");
        }}
        error={validationErrors.email || fieldErrors.email}
        status={fieldStatus.email}
        placeholder="e.g. name@company.com"
        helper={validatingFields.email ? "Checking email..." : undefined}
        info={contactTooltips.email}
        required
      />

      <div className="grid gap-5 md:grid-cols-[minmax(150px,180px)_minmax(190px,220px)_1fr]">
        <SearchableSelect
          label="Phone Type"
          value={formData.contact.mobileType}
          onChange={(value) => {
            onFieldBlur("mobileType");
            onContactChange("mobileType", value as BusinessAccountFormData["contact"]["mobileType"]);
          }}
          options={mobileTypeOptions}
          error={validationErrors.mobileType}
          status={fieldStatus.mobileType}
          info={contactTooltips.mobileType}
          required
        />
        <CountryCodeField
          value={formData.contact.countryCode}
          onChange={(value) => onContactChange("countryCode", value)}
          error={validationErrors.countryCode}
          required
        />
        <Field
          label="Mobile Number"
          value={formData.contact.mobileNumber}
          onChange={(value) => onContactChange("mobileNumber", value)}
          onBlur={() => {
            onFieldBlur("mobileNumber");
            if (!operatorDraftMode) void onValidateUniqueField("mobileNumber");
          }}
          error={validationErrors.mobileNumber || fieldErrors.mobileNumber}
          status={fieldStatus.mobileNumber}
          placeholder="Number without the country code"
          helper={validatingFields.mobileNumber ? "Checking mobile number..." : undefined}
          info={contactTooltips.mobileNumber}
          required
        />
      </div>

      <div className="grid items-start gap-5 md:grid-cols-2">
        <JobTitleField
          value={formData.contact.jobTitle}
          error={validationErrors.jobTitle}
          status={fieldStatus.jobTitle}
          onChange={(value) => onContactChange("jobTitle", value)}
          onBlur={() => onFieldBlur("jobTitle")}
        />
        <SearchableSelect
          label="Department"
          value={formData.contact.department}
          onChange={(value) => {
            onFieldBlur("department");
            onContactChange("department", value);
          }}
          options={toOptions(departments)}
          error={validationErrors.department}
          status={fieldStatus.department}
          info={contactTooltips.department}
          required
        />
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <SearchableSelect
          label="Shipment Type"
          value={formData.contact.shipmentTypes[0] ?? ""}
          onChange={(value) => {
            onFieldBlur("shipmentTypes");
            onShipmentTypeChange(value);
          }}
          options={shipmentTypeOptions}
          error={validationErrors.shipmentTypes}
          status={fieldStatus.shipmentTypes}
          info={contactTooltips.shipmentTypes}
          required
        />
      </div>
    </div>
  );
}
