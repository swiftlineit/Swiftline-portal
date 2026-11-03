"use client";

import { useEffect, useMemo, useState } from "react";
import { FiChevronDown } from "react-icons/fi";
import {
  CheckboxField,
  ComboBoxField,
  CountryRegistrationSelect,
  Field,
  FieldShell,
  MultiSearchableSelect,
  SearchableSelect,
  type CompanyUpdater,
  type FieldStatus,
  type UniqueField,
  registrationTypeOptionsByCountry,
  companyTypeOptions,
  countryOptions,
  currencyOptions,
  industries,
  registrationConfig,
  shipmentVolumes,
  toOptions,
  getCurrencyCode,
} from "@/components/business-accounts/FormFieldControls";
import { AddressAutocompleteField } from "@/components/business-accounts/AddressAutocompleteField";
import {
  emptyBusinessAddress,
  type BusinessAccountFormData,
  type BusinessAddress,
} from "@/lib/businessAccounts";
import type { LookupAddress } from "@/lib/addressLookup";
import {
  getPostalCodeFormat,
  getPostalCodePlaceholder,
} from "@/lib/businessAccountPostalCodes";
import {
  GSTIN_EXAMPLE,
  GSTIN_LENGTH,
  getGstinStateName,
  normalizeGstin,
} from "@/lib/gstin";
import {
  GST_EXEMPT_REASON_MAX,
  collectsGstin,
} from "@/lib/businessAccountValidation";
import {
  companyTooltips,
  sectionTooltips,
} from "@/lib/businessAccountTooltips";
import InfoTooltip from "@/components/ui/InfoTooltip";
import {
  fetchCities,
  fetchStates,
  findStateCode,
  matchStateName,
  type GeographyState,
} from "@/lib/geography";
import {
  defaultUsTaxIdType,
  formatUsTaxId,
  isMaskedUsTaxId,
  isUsTaxIdType,
  usTaxIdExamples,
  usTaxIdLabels,
  type UsTaxIdType,
} from "@/lib/usTaxId";
import {
  getPrimaryRegistrationRule,
  getSecondaryRegistrationRule,
} from "@/lib/businessAccountRegistrationRules";
import { BUSINESS_ACCOUNT_CREDIT_LIMIT_MAX } from "@/lib/businessAccountContactRules";

// Company step UI for registration, address, and credit details.
export function CompanyStep({
  formData,
  validationErrors,
  fieldStatus,
  fieldWarnings,
  fieldErrors,
  validatingFields,
  onCompanyChange,
  onGstBillingChange,
  onValidateUniqueField,
  onFieldBlur,
  hideGstTreatmentSection = false,
  operatorBillingAddressForNoCompany = false,
}: {
  formData: BusinessAccountFormData;
  validationErrors: Record<string, string>;
  fieldStatus: Record<string, FieldStatus>;
  fieldWarnings: Record<string, string>;
  fieldErrors: Partial<Record<UniqueField, string>>;
  validatingFields: Partial<Record<UniqueField, boolean>>;
  onCompanyChange: CompanyUpdater;
  onGstBillingChange?: <Key extends keyof BusinessAccountFormData["gstBilling"]>(
    key: Key,
    value: BusinessAccountFormData["gstBilling"][Key],
  ) => void;
  onValidateUniqueField: (field: UniqueField) => Promise<boolean>;
  onFieldBlur: (...keys: string[]) => void;
  hideGstTreatmentSection?: boolean;
  operatorBillingAddressForNoCompany?: boolean;
}) {
  const selectedRegistrationCountry = formData.company.registrationCountry;
  const selectedRegistrationConfig =
    registrationConfig[selectedRegistrationCountry];
  const showsRegistrationField =
    Boolean(selectedRegistrationConfig) ||
    selectedRegistrationCountry === "Canada";
  const requiresSecondaryRegistration = Boolean(
    selectedRegistrationConfig?.secondaryLabel,
  );
  const noRegistrationChecked = Boolean(formData.company.noCompanyRegistration);
  const noCompanyChecked = Boolean(formData.company.noCompany);
  const primaryRegistrationRule = getPrimaryRegistrationRule(
    selectedRegistrationCountry,
    formData.company.registrationIdType,
  );
  const secondaryRegistrationRule = getSecondaryRegistrationRule(
    selectedRegistrationCountry,
  );
  const selectedAddressCountry =
    formData.company.addressCountry ?? formData.company.registrationCountry;
  const isUnitedStates = selectedRegistrationCountry === "United States";
  const registrationTypeOptions =
    registrationTypeOptionsByCountry[selectedRegistrationCountry] ?? null;
  const selectedRegistrationType =
    formData.company.registrationIdType ||
    (isUnitedStates
      ? defaultUsTaxIdType(noCompanyChecked)
      : registrationTypeOptions?.[0]?.value) ||
    "";
  const usTaxIdType: UsTaxIdType = isUsTaxIdType(selectedRegistrationType)
    ? selectedRegistrationType
    : "ein";
  // Each cache records which country or state its contents belong to, so
  // "loading" is derived from that mismatch rather than toggled in an effect-
  // no synchronous setState, and the spinner is already showing on the render
  // where the country changed.
  const [states, setStates] = useState<GeographyState[]>([]);
  const [statesCountry, setStatesCountry] = useState("");
  const [cities, setCities] = useState<string[]>([]);
  const [citiesKey, setCitiesKey] = useState("");

  const selectedState = formData.company.stateOrProvince;
  const selectedStateCode = findStateCode(states, selectedState);
  const wantedCitiesKey = selectedStateCode
    ? `${selectedAddressCountry}:${selectedStateCode}`
    : "";
  const loadingStates = statesCountry !== selectedAddressCountry;
  const loadingCities =
    Boolean(wantedCitiesKey) && citiesKey !== wantedCitiesKey;

  useEffect(() => {
    let cancelled = false;

    // A slower response for a country the user has since moved away from must
    // not overwrite the newer one.
    void fetchStates(selectedAddressCountry).then((result) => {
      if (cancelled) return;
      setStates(result);
      setStatesCountry(selectedAddressCountry);
    });

    return () => {
      cancelled = true;
    };
  }, [selectedAddressCountry]);

  useEffect(() => {
    if (!wantedCitiesKey) return;

    let cancelled = false;

    void fetchCities(selectedAddressCountry, selectedStateCode).then(
      (result) => {
        if (cancelled) return;
        setCities(result);
        setCitiesKey(wantedCitiesKey);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [wantedCitiesKey, selectedAddressCountry, selectedStateCode]);

  const stateOptions = useMemo(() => {
    const options = states.map((state) => ({
      value: state.name,
      label: state.name,
    }));

    // A stored state that is not on the list (an older record, or a spelling the
    // dataset does not use) stays selectable rather than being silently dropped.
    if (
      selectedState &&
      !states.some((state) => state.name === selectedState)
    ) {
      return [
        ...options,
        { value: selectedState, label: `${selectedState} (current)` },
      ];
    }

    return options;
  }, [states, selectedState]);

  // Only offer cities that belong to the state currently selected; a stale list
  // from the previous state would suggest places in the wrong region.
  const cityOptions =
    wantedCitiesKey && citiesKey === wantedCitiesKey ? cities : [];

  const usesCompanyAddressForBilling = Boolean(
    formData.company.useCompanyAddressAsBillingAddress,
  );
  const billingAddress =
    formData.company.billingAddress ?? emptyBusinessAddress;

  const [billingStates, setBillingStates] = useState<GeographyState[]>([]);
  const [billingStatesCountry, setBillingStatesCountry] = useState("");
  const [billingCities, setBillingCities] = useState<string[]>([]);
  const [billingCitiesKey, setBillingCitiesKey] = useState("");

  const billingStateCode = findStateCode(
    billingStates,
    billingAddress.stateOrProvince,
  );
  const wantedBillingCitiesKey = billingStateCode
    ? `${billingAddress.country}:${billingStateCode}`
    : "";

  useEffect(() => {
    if (usesCompanyAddressForBilling || !billingAddress.country) return;

    let cancelled = false;

    void fetchStates(billingAddress.country).then((result) => {
      if (cancelled) return;
      setBillingStates(result);
      setBillingStatesCountry(billingAddress.country);
    });

    return () => {
      cancelled = true;
    };
  }, [usesCompanyAddressForBilling, billingAddress.country]);

  useEffect(() => {
    if (!wantedBillingCitiesKey) return;

    let cancelled = false;

    void fetchCities(billingAddress.country, billingStateCode).then(
      (result) => {
        if (cancelled) return;
        setBillingCities(result);
        setBillingCitiesKey(wantedBillingCitiesKey);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [wantedBillingCitiesKey, billingAddress.country, billingStateCode]);

  const billingStateOptions = useMemo(() => {
    if (billingStatesCountry !== billingAddress.country) return [];

    const options = billingStates.map((state) => ({
      value: state.name,
      label: state.name,
    }));
    const stored = billingAddress.stateOrProvince;

    if (stored && !billingStates.some((state) => state.name === stored)) {
      return [...options, { value: stored, label: `${stored} (current)` }];
    }

    return options;
  }, [
    billingStates,
    billingStatesCountry,
    billingAddress.country,
    billingAddress.stateOrProvince,
  ]);

  const billingCityOptions =
    wantedBillingCitiesKey && billingCitiesKey === wantedBillingCitiesKey
      ? billingCities
      : [];

  function updateBillingAddress(patch: Partial<BusinessAddress>) {
    onCompanyChange("billingAddress", { ...billingAddress, ...patch });
  }

  function applyLookupToBillingAddress(address: LookupAddress) {
    const country = billingAddress.country || selectedAddressCountry;

    updateBillingAddress({
      addressLine1: address.addressLine1 || billingAddress.addressLine1,
      postalCode: address.postalCode,
      stateOrProvince: matchStateName(billingStates, address.state),
      city: address.city,
      country,
    });

    onFieldBlur(
      "billingAddressLine1",
      "billingPostalCode",
      "billingState",
      "billingCity",
    );
  }
  const gstExemptChecked = Boolean(formData.company.gstExempt);
  const collectsGst = collectsGstin(
    selectedRegistrationCountry,
    noCompanyChecked,
  );
  const gstinStateName = getGstinStateName(formData.company.gstin ?? "");

  const countryCurrencyMap: Record<string, string> = {
    India: "INR",
    "United States": "USD",
    "United Kingdom": "GBP",
    France: "EUR",
    Netherlands: "EUR",
    Kuwait: "KWD",
    Canada: "CAD",
    Switzerland: "CHF",
    Poland: "EUR",
    Australia: "AUD",
    "United Arab Emirates": "AED",
    "Saudi Arabia": "SAR",
    Singapore: "SGD",
    China: "CNY",
    Japan: "JPY",
    Qatar: "QAR",
    Oman: "OMR",
    Bahrain: "BHD",
    "New Zealand": "NZD",
  };

  /**
   * Fills the address fields from a picked suggestion.
   *
   * The state has to be resolved against the reference list rather than stored
   * verbatim: the dropdown can only show a value that is one of its options, and
   * the provider's spelling does not always match the dataset's. Address line 2
   * is deliberately left alone- it holds what the user knows and the lookup
   * does not.
   */
  function applyLookupToCompanyAddress(address: LookupAddress) {
    onCompanyChange(
      "registeredAddress",
      address.addressLine1 || formData.company.registeredAddress,
    );
    onCompanyChange("postalCode", address.postalCode);

    const matchedState = matchStateName(states, address.state);
    onCompanyChange("stateOrProvince", matchedState);
    // Without a matched state the city list cannot load, but the combo box
    // still accepts the provider's value as free text.
    onCompanyChange("city", address.city);

    onFieldBlur("registeredAddress", "postalCode", "stateOrProvince", "city");
  }

  function handleRegistrationCountryChange(country: string) {
    const nextConfig = registrationConfig[country];

    onCompanyChange("registrationCountry", country);
    onCompanyChange(
      "registrationIdType",
      country === "Canada"
        ? "business_number"
        : country === "United States"
          ? defaultUsTaxIdType(formData.company.noCompany)
          : (nextConfig?.primaryTypeValue ?? ""),
    );
    onCompanyChange("registrationId", "");
    onCompanyChange("secondaryRegistrationId", "");
    onCompanyChange("noCompanyRegistration", false);
    // GST only exists for India. Leaving a value behind would strand it on a
    // hidden field: the form would report itself valid while the server still
    // rejected the stale GSTIN.
    onCompanyChange("gstin", "");
    onCompanyChange("gstExempt", false);
    onCompanyChange("gstExemptReason", "");
    onCompanyChange("operatingCountries", [country]);
    onCompanyChange("addressCountry", country);
    onCompanyChange(
      "requestedCreditCurrency",
      countryCurrencyMap[country] ?? "INR",
    );
  }

  return (
    <div
      className={`space-y-8 ${hideGstTreatmentSection ? "public-company-step" : "mt-5"}`}
    >
      <section className="space-y-5 border border-slate-200 bg-white p-5 rounded-xl shadow-sm">
        <h3 className="flex items-center gap-1.5 text-sm font-bold text-slate-950">
          Company registration
          <InfoTooltip text={sectionTooltips.registration} />
        </h3>
        <CountryRegistrationSelect
          label="Country of Registration"
          value={formData.company.registrationCountry}
          onChange={handleRegistrationCountryChange}
          error={validationErrors.registrationCountry}
          required
        />

        {showsRegistrationField ? (
          <div
            className={
              registrationTypeOptions
                ? "grid gap-5 md:grid-cols-[minmax(220px,280px)_1fr]"
                : "grid gap-5"
            }
          >
            {registrationTypeOptions ? (
              <SearchableSelect
                label={isUnitedStates ? "Tax ID Type" : "Registration ID Type"}
                value={selectedRegistrationType}
                onChange={(value) => {
                  onCompanyChange("registrationIdType", value);
                  // Each type has its own format and punctuation, so a value
                  // typed for the previous one cannot carry over.
                  onCompanyChange("registrationId", "");
                }}
                options={registrationTypeOptions}
                error={validationErrors.registrationIdType}
                info={isUnitedStates ? companyTooltips.usTaxIdType : undefined}
                // A US account needs a taxpayer ID whether or not there is a
                // company behind it, so neither tick disables the picker.
                disabled={isUnitedStates ? false : noCompanyChecked}
                required={
                  isUnitedStates ||
                  (!noRegistrationChecked && !noCompanyChecked)
                }
              />
            ) : null}

            <Field
              label={
                registrationTypeOptions
                  ? isUnitedStates
                    ? usTaxIdLabels[usTaxIdType]
                    : (registrationTypeOptions.find(
                        (option) => option.value === selectedRegistrationType,
                      )?.label ?? "Registration ID")
                  : (selectedRegistrationConfig?.primaryLabel ??
                    "Registration ID")
              }
              value={formData.company.registrationId}
              onChange={(value) =>
                onCompanyChange(
                  "registrationId",
                  // US identifiers are digits with fixed punctuation, inserted as
                  // the user types; every other country is free-form uppercase.
                  isUnitedStates
                    ? isMaskedUsTaxId(value)
                      ? value
                      : formatUsTaxId(value, usTaxIdType)
                    : value.toUpperCase(),
                )
              }
              onBlur={() => {
                onFieldBlur("registrationId");
                void onValidateUniqueField("registrationId");
              }}
              error={
                validationErrors.registrationId || fieldErrors.registrationId
              }
              warning={fieldWarnings.registrationId}
              status={fieldStatus.registrationId}
              placeholder={
                isUnitedStates
                  ? `e.g. ${usTaxIdExamples[usTaxIdType]}`
                  : undefined
              }
              helper={
                validatingFields.registrationId
                  ? "Checking registration ID..."
                  : undefined
              }
              info={
                primaryRegistrationRule?.info ??
                selectedRegistrationConfig?.primaryInfo ??
                "Enter the selected Canadian company registration number."
              }
              disabled={
                isUnitedStates
                  ? false
                  : noRegistrationChecked || noCompanyChecked
              }
              maxLength={primaryRegistrationRule?.maxLength}
              required={
                isUnitedStates || (!noRegistrationChecked && !noCompanyChecked)
              }
            />

            {requiresSecondaryRegistration ? (
              <Field
                label={
                  selectedRegistrationConfig.secondaryLabel ??
                  "Additional Registration Code"
                }
                value={formData.company.secondaryRegistrationId ?? ""}
                onChange={(value) =>
                  onCompanyChange(
                    "secondaryRegistrationId",
                    value.toUpperCase(),
                  )
                }
                onBlur={() => onFieldBlur("secondaryRegistrationId")}
                error={validationErrors.secondaryRegistrationId}
                status={fieldStatus.secondaryRegistrationId}
                info={
                  secondaryRegistrationRule?.info ??
                  selectedRegistrationConfig.secondaryInfo
                }
                disabled={noRegistrationChecked || noCompanyChecked}
                maxLength={secondaryRegistrationRule?.maxLength}
                required={!noRegistrationChecked && !noCompanyChecked}
              />
            ) : null}
          </div>
        ) : null}

        {/* Every US person and entity holds an EIN, SSN or ITIN, so there is no
            legitimate case for skipping it- and offering the tick would be a
            one-click bypass of a mandatory field. */}
        {isUnitedStates ? null : (
          <CheckboxField
            label="I don't have a company registration no. for this country"
            info={companyTooltips.noCompanyRegistration}
            checked={noRegistrationChecked}
            onChange={(checked) => {
              onCompanyChange("noCompanyRegistration", checked);
              if (checked) {
                onCompanyChange("registrationId", "");
                onCompanyChange("secondaryRegistrationId", "");
              }
            }}
          />
        )}

        {noRegistrationChecked ? (
          <div className="border border-yellow-300 bg-yellow-50 px-3 py-3 text-sm leading-6 text-slate-900">
            We will not be able to process your account number creation
            immediately without the registration number. Please enter your
            company details manually and submit your request.
          </div>
        ) : null}
      </section>

      <section className="space-y-5 px-5 bg-blue-100/50 rounded-xl py-5">
        <h2 className="flex items-center gap-1.5 text-xl font-bold text-slate-950">
          Company details
          <InfoTooltip text={sectionTooltips.companyDetails} />
        </h2>
        <div className="rounded-xl border border-[#D6E5E7] bg-white px-4 py-3.5">
          <CheckboxField
            label="I don't have any company"
            info={companyTooltips.noCompany}
            checked={noCompanyChecked}
            onChange={(checked) => {
              onCompanyChange("noCompany", checked);
              if (checked) {
                onCompanyChange("noCompanyRegistration", true);
                onCompanyChange("registrationId", "");
                onCompanyChange("secondaryRegistrationId", "");
                if (operatorBillingAddressForNoCompany) {
                  onCompanyChange("useCompanyAddressAsBillingAddress", false);
                  if (!billingAddress.country) {
                    onCompanyChange("billingAddress", {
                      ...billingAddress,
                      country: selectedAddressCountry
                    });
                  }
                }
              }

              // A US account still needs a taxpayer ID either way, but which one
              // changes: a business holds an EIN, an individual an SSN or ITIN.
              if (isUnitedStates) {
                onCompanyChange(
                  "registrationIdType",
                  defaultUsTaxIdType(checked),
                );
                onCompanyChange("registrationId", "");
              }
            }}
          />
        </div>
        <div className="grid gap-5 rounded-xl border border-[#D6E5E7] bg-white p-4 md:grid-cols-2">
          <Field
            label="Company Name"
            value={formData.company.companyName}
            onChange={(value) => onCompanyChange("companyName", value)}
            onBlur={() => onFieldBlur("companyName")}
            error={validationErrors.companyName}
            status={fieldStatus.companyName}
            disabled={noCompanyChecked}
            required={!noCompanyChecked}
          />
          <SearchableSelect
            label="Company Type"
            value={formData.company.companyType}
            onChange={(value) => {
              onFieldBlur("companyType");
              onCompanyChange("companyType", value);
            }}
            options={companyTypeOptions}
            error={validationErrors.companyType}
            status={fieldStatus.companyType}
            placeholder="Company Type"
            info={companyTooltips.companyType}
            disabled={noCompanyChecked}
            required={!noCompanyChecked}
          />
        </div>

        {collectsGst ? (
          <div className="grid gap-4 rounded-xl border border-[#D6E5E7] bg-white p-4">
            <Field
              label="GSTIN"
              value={formData.company.gstin ?? ""}
              onChange={(value) =>
                onCompanyChange("gstin", normalizeGstin(value))
              }
              onBlur={() => onFieldBlur("gstin")}
              error={validationErrors.gstin}
              warning={fieldWarnings.gstin}
              status={fieldStatus.gstin}
              placeholder={`e.g. ${GSTIN_EXAMPLE}`}
              helper={
                gstinStateName
                  ? `State code ${(formData.company.gstin ?? "").slice(0, 2)}- ${gstinStateName}`
                  : undefined
              }
              info={companyTooltips.gstin}
              disabled={noCompanyChecked || gstExemptChecked}
              maxLength={GSTIN_LENGTH}
              required={!gstExemptChecked}
            />

            <div className="rounded-lg bg-[#F8FBFB] px-3.5 py-3">
              <CheckboxField
                label="GST Exempt / Not Registered"
                info={companyTooltips.gstExempt}
                checked={gstExemptChecked}
                disabled={noCompanyChecked}
                onChange={(checked) => {
                  onCompanyChange("gstExempt", checked);
                  // The two are mutually exclusive, so claiming exemption clears
                  // any GSTIN that was typed before the tick.
                  if (checked) onCompanyChange("gstin", "");
                  else onCompanyChange("gstExemptReason", "");
                }}
              />
            </div>

            {gstExemptChecked ? (
              <div className="grid gap-4 rounded-2xl border border-yellow-300 bg-yellow-50 px-4 py-4">
                <p className="text-sm leading-6 text-slate-900">
                  This account will be submitted as exempt from GST
                  registration. An administrator must approve the exemption
                  during KYC review before the account can be approved or
                  activated.
                </p>
                <Field
                  label="Reason for GST Exemption"
                  value={formData.company.gstExemptReason ?? ""}
                  onChange={(value) =>
                    onCompanyChange("gstExemptReason", value)
                  }
                  onBlur={() => onFieldBlur("gstExemptReason")}
                  error={validationErrors.gstExemptReason}
                  status={fieldStatus.gstExemptReason}
                  placeholder="e.g. Turnover below the GST registration threshold"
                  info={companyTooltips.gstExemptReason}
                  maxLength={GST_EXEMPT_REASON_MAX}
                  required
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      {hideGstTreatmentSection ? null : (
        <section className="space-y-5 rounded-xl border border-slate-200 bg-amber-400/10 px-5 py-5">
          <div>
            <p className="text-sm leading-6 text-slate-900">
              No GST billing is subject to administrator approval. Pending or
              rejected requests are billed with normal GST.
            </p>
          </div>
          <div className="w-full">
            <FieldShell
              label="GST treatment"
              labelFor="gst-billing-treatment"
            >
              <div className="relative">
                <select
                  id="gst-billing-treatment"
                  value={formData.gstBilling.requestedTreatment}
                  onChange={(event) => {
                    const value = event.target
                      .value as BusinessAccountFormData["gstBilling"]["requestedTreatment"];
                    onGstBillingChange?.("requestedTreatment", value);
                    if (value === "GST_APPLICABLE")
                      onGstBillingChange?.("requestReason", "");
                  }}
                  className="block h-14 mb-4 w-full appearance-none rounded-xl border border-[#EEEDED] bg-white px-4 pr-11 text-sm text-slate-900 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-[#F0DE36]/35"
                >
                  <option value="GST_APPLICABLE">GST applicable</option>
                  <option value="NO_GST">No GST requested</option>
                </select>
                <FiChevronDown
                  aria-hidden="true"
                  className="pointer-events-none absolute right-4 top-1/2 h-5 w-5 -translate-y-1/2 text-[#0D1282]"
                />
              </div>
            </FieldShell>
            {formData.gstBilling.requestedTreatment === "NO_GST" ? (
              <Field
                label="Reason for no-GST billing"
                value={formData.gstBilling.requestReason}
                onChange={(value) => onGstBillingChange?.("requestReason", value)}
                onBlur={() => onFieldBlur("gstBillingRequestReason")}
                error={validationErrors.gstBillingRequestReason}
                status={fieldStatus.gstBillingRequestReason}
                maxLength={500}
                placeholder="Enter the reason for requesting no-GST billing"
                required
              />
            ) : null}
          </div>
        </section>
      )}

      <section className="space-y-5 border-slate-200 px-5 bg-amber-100/10 py-5 rounded-xl">
        {/* <h3 className="flex items-center gap-1.5 text-sm font-bold text-slate-950">
          Company address
          <InfoTooltip text={sectionTooltips.companyAddress} />
        </h3> */}
        {selectedRegistrationCountry === "United States" ? (
          <div className="border border-yellow-300 bg-yellow-50 px-3 py-3 text-sm leading-6 text-slate-900">
            SWIFTLINE does not open accounts at USPS, retail postal locations or
            PO boxes. Please provide the physical address of the company within
            the US. You must be age 19 or older to open an account.
          </div>
        ) : null}
        <div className="grid gap-5 md:grid-cols-2">
          <div className="md:col-span-2">
            <AddressAutocompleteField
              label="Company Address"
              value={formData.company.registeredAddress}
              countryName={selectedAddressCountry}
              onChange={(value) => onCompanyChange("registeredAddress", value)}
              onBlur={() => onFieldBlur("registeredAddress")}
              onAddressSelected={applyLookupToCompanyAddress}
              error={validationErrors.registeredAddress}
              status={fieldStatus.registeredAddress}
              disabled={noCompanyChecked}
              required={!noCompanyChecked}
            />
          </div>
          <div className="md:col-span-2">
            <Field
              label="Address Line 2"
              value={formData.company.addressLine2 ?? ""}
              onChange={(value) => onCompanyChange("addressLine2", value)}
              onBlur={() => onFieldBlur("addressLine2")}
              error={validationErrors.addressLine2}
              status={fieldStatus.addressLine2}
              placeholder="Building, floor, unit or landmark"
              info={companyTooltips.addressLine2}
              maxLength={200}
              disabled={noCompanyChecked}
            />
          </div>
          {/* Order matters: the state drives which cities are offered, so it
              reads left to right in the order it must be filled. */}
          {stateOptions.length ? (
            <SearchableSelect
              label="State or Province"
              value={formData.company.stateOrProvince}
              onChange={(value) => {
                onFieldBlur("stateOrProvince");
                onCompanyChange("stateOrProvince", value);
                // The previous city belongs to the previous state.
                onCompanyChange("city", "");
              }}
              options={stateOptions}
              error={validationErrors.stateOrProvince}
              status={fieldStatus.stateOrProvince}
              info={`States and union territories of ${selectedAddressCountry}.`}
              disabled={noCompanyChecked}
              required={!noCompanyChecked}
            />
          ) : (
            <Field
              label="State or Province"
              value={formData.company.stateOrProvince}
              onChange={(value) => onCompanyChange("stateOrProvince", value)}
              onBlur={() => onFieldBlur("stateOrProvince")}
              error={validationErrors.stateOrProvince}
              status={fieldStatus.stateOrProvince}
              helper={loadingStates ? "Loading states..." : undefined}
              info={`No subdivision list is available for ${selectedAddressCountry}. Enter the state or province as it appears on your documents.`}
              disabled={noCompanyChecked}
              required={!noCompanyChecked}
            />
          )}
          <ComboBoxField
            label="City"
            value={formData.company.city}
            onChange={(value) => onCompanyChange("city", value)}
            onBlur={() => onFieldBlur("city")}
            options={cityOptions}
            error={validationErrors.city}
            status={fieldStatus.city}
            loading={loadingCities}
            info={companyTooltips.city}
            maxLength={80}
            disabled={noCompanyChecked}
            required={!noCompanyChecked}
          />
          <div className="grid gap-5 md:col-span-2 md:grid-cols-[minmax(140px,220px)_minmax(0,1fr)]">
            <Field
              label="Postal Code"
              value={formData.company.postalCode}
              onChange={(value) => onCompanyChange("postalCode", value)}
              onBlur={() => onFieldBlur("postalCode")}
              error={validationErrors.postalCode}
              status={fieldStatus.postalCode}
              placeholder={getPostalCodePlaceholder(selectedAddressCountry)}
              info={`Expected format for ${selectedAddressCountry}: ${getPostalCodeFormat(selectedAddressCountry)}`}
              disabled={noCompanyChecked}
              required={!noCompanyChecked}
            />
            <SearchableSelect
              label="Country"
              value={selectedAddressCountry}
              onChange={(value) => {
                onFieldBlur("addressCountry");
                onCompanyChange("addressCountry", value);
                // A state and city from the previous country cannot be valid
                // for the new one.
                onCompanyChange("stateOrProvince", "");
                onCompanyChange("city", "");
              }}
              options={countryOptions}
              error={validationErrors.addressCountry}
              status={fieldStatus.addressCountry}
              info={companyTooltips.addressCountry}
              disabled={noCompanyChecked}
              required={!noCompanyChecked}
            />
          </div>
          <div className="md:col-span-2">
            <MultiSearchableSelect
              label="Operating Countries"
              values={formData.company.operatingCountries}
              onChange={(value) => {
                onFieldBlur("operatingCountries");
                onCompanyChange("operatingCountries", value);
              }}
              options={countryOptions}
              error={validationErrors.operatingCountries}
              status={fieldStatus.operatingCountries}
              info={companyTooltips.operatingCountries}
              disabled={noCompanyChecked}
              required={!noCompanyChecked}
            />
          </div>
        </div>
        {operatorBillingAddressForNoCompany && noCompanyChecked ? (
          <p className="text-sm leading-5 text-slate-600">
            Add the address that should appear on this account&apos;s tax invoices.
          </p>
        ) : (
          <CheckboxField
            label="Use company address as billing address"
            info={companyTooltips.useCompanyAddressAsBillingAddress}
            checked={usesCompanyAddressForBilling}
            disabled={noCompanyChecked}
            onChange={(checked) =>
              onCompanyChange("useCompanyAddressAsBillingAddress", checked)
            }
          />
        )}

        {(!usesCompanyAddressForBilling && !noCompanyChecked)
          || (operatorBillingAddressForNoCompany && noCompanyChecked) ? (
          <div className="grid gap-5 rounded-2xl border border-[#EEEDED] bg-[#EEEDED]/25 p-5 md:grid-cols-2">
            <div className="md:col-span-2">
              <h4 className="text-sm font-bold text-slate-950">
                Billing address
              </h4>
              <p className="mt-1 text-xs text-slate-500">
                Where invoices for this account are issued.
              </p>
            </div>

            <div className="md:col-span-2">
              <AddressAutocompleteField
                label="Billing Address"
                value={billingAddress.addressLine1}
                countryName={billingAddress.country || selectedAddressCountry}
                onChange={(value) =>
                  updateBillingAddress({ addressLine1: value })
                }
                onBlur={() => onFieldBlur("billingAddressLine1")}
                onAddressSelected={applyLookupToBillingAddress}
                error={validationErrors.billingAddressLine1}
                status={fieldStatus.billingAddressLine1}
                required
              />
            </div>
            <div className="md:col-span-2">
              <Field
                label="Billing Address Line 2"
                value={billingAddress.addressLine2}
                onChange={(value) =>
                  updateBillingAddress({ addressLine2: value })
                }
                placeholder="Building, floor, unit or landmark"
                maxLength={200}
              />
            </div>
            <ComboBoxField
              label="Billing City"
              value={billingAddress.city}
              onChange={(value) => updateBillingAddress({ city: value })}
              onBlur={() => onFieldBlur("billingCity")}
              options={billingCityOptions}
              error={validationErrors.billingCity}
              status={fieldStatus.billingCity}
              maxLength={80}
              required
            />
            {billingStateOptions.length ? (
              <SearchableSelect
                label="Billing State or Province"
                value={billingAddress.stateOrProvince}
                onChange={(value) => {
                  onFieldBlur("billingState");
                  updateBillingAddress({ stateOrProvince: value, city: "" });
                }}
                options={billingStateOptions}
                error={validationErrors.billingState}
                status={fieldStatus.billingState}
                required
              />
            ) : (
              <Field
                label="Billing State or Province"
                value={billingAddress.stateOrProvince}
                onChange={(value) =>
                  updateBillingAddress({ stateOrProvince: value })
                }
                onBlur={() => onFieldBlur("billingState")}
                error={validationErrors.billingState}
                status={fieldStatus.billingState}
                required
              />
            )}
            <Field
              label="Billing Postal Code"
              value={billingAddress.postalCode}
              onChange={(value) => updateBillingAddress({ postalCode: value })}
              onBlur={() => onFieldBlur("billingPostalCode")}
              error={validationErrors.billingPostalCode}
              status={fieldStatus.billingPostalCode}
              placeholder={getPostalCodePlaceholder(
                billingAddress.country || selectedAddressCountry,
              )}
              required
            />
            <SearchableSelect
              label="Billing Country"
              value={billingAddress.country}
              onChange={(value) => {
                onFieldBlur("billingCountry");
                // A state and city from the previous country cannot be valid
                // for the new one.
                updateBillingAddress({
                  country: value,
                  stateOrProvince: "",
                  city: "",
                });
              }}
              options={countryOptions}
              error={validationErrors.billingCountry}
              status={fieldStatus.billingCountry}
              required
            />
          </div>
        ) : null}
      </section>

      <section className="space-y-5 px-5">
        {/* <h3 className="flex items-center gap-1.5 text-sm font-bold text-slate-950">
          Additional information
          <InfoTooltip text={sectionTooltips.additionalInformation} />
        </h3> */}
        <div className="grid gap-5 md:grid-cols-2">
          <Field
            label="Company Website"
            type="url"
            value={formData.company.website ?? ""}
            onChange={(value) => onCompanyChange("website", value)}
            onBlur={() => onFieldBlur("website")}
            error={validationErrors.website}
            status={fieldStatus.website}
            placeholder="e.g. https://www.company.com"
            info={companyTooltips.website}
            disabled={noCompanyChecked}
          />
          <SearchableSelect
            label="Company Industry"
            info={companyTooltips.industry}
            value={formData.company.industry}
            onChange={(value) => {
              onFieldBlur("industry");
              onCompanyChange("industry", value);
            }}
            options={toOptions(industries)}
            error={validationErrors.industry}
            status={fieldStatus.industry}
            disabled={noCompanyChecked}
            required={!noCompanyChecked}
          />
          <SearchableSelect
            label="Monthly Shipment Volume"
            value={formData.company.monthlyShipmentVolume}
            onChange={(value) => {
              onFieldBlur("monthlyShipmentVolume");
              onCompanyChange("monthlyShipmentVolume", value);
            }}
            options={toOptions(shipmentVolumes)}
            error={validationErrors.monthlyShipmentVolume}
            status={fieldStatus.monthlyShipmentVolume}
            info={companyTooltips.monthlyShipmentVolume}
            disabled={noCompanyChecked}
            required={!noCompanyChecked}
          />
          <div className="grid grid-cols-[200px_1fr] gap-3">
            <SearchableSelect
              label="Currency"
              info={companyTooltips.requestedCreditCurrency}
              value={formData.company.requestedCreditCurrency}
              onChange={(value) => {
                onFieldBlur("requestedCreditCurrency");
                onCompanyChange(
                  "requestedCreditCurrency",
                  getCurrencyCode(value),
                );
              }}
              options={currencyOptions}
              error={validationErrors.requestedCreditCurrency}
              status={fieldStatus.requestedCreditCurrency}
              disabled={noCompanyChecked}
              required
            />
            <Field
              label="Requested Credit "
              placeholder={`Max ${BUSINESS_ACCOUNT_CREDIT_LIMIT_MAX}`}
              type="number"
              value={formData.company.requestedCreditLimit}
              onChange={(value) =>
                onCompanyChange("requestedCreditLimit", value)
              }
              onBlur={() => onFieldBlur("requestedCreditLimit")}
              error={validationErrors.requestedCreditLimit}
              status={fieldStatus.requestedCreditLimit}
              info={`Optional. The credit you would like on the account, up to ${BUSINESS_ACCOUNT_CREDIT_LIMIT_MAX}. Subject to review.`}
              disabled={noCompanyChecked}
              max={BUSINESS_ACCOUNT_CREDIT_LIMIT_MAX}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
