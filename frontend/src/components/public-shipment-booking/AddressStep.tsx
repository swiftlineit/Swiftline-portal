"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "react-toastify";
import {
  PublicAddressAutocompleteField,
  PublicFixedCountryField,
  PublicPhoneCodeField,
  PublicSearchableSelect,
} from "./PublicAddressControls";
import { countryCodeOptions } from "@/lib/countries";
import {
  fetchCities,
  fetchStates,
  findStateCode,
  matchStateName,
  type GeographyState,
} from "@/lib/geography";
import { formatAadhaarNumber, normalizeAadhaarNumber } from "@/lib/aadhaar";
import { getDialCodeForCountryCode } from "@/lib/shipmentContactValidation";
import type { PublicAddress, PublicSender } from "@/lib/publicShipmentBooking";
import { BookingField } from "./BookingField";

const PUBLIC_REFERENCE_ROOT = "/api/v1/public/shipment-bookings/reference";
const PUBLIC_ADDRESS_ROOT = "/api/v1/public/shipment-bookings/address-lookup";

type Props = {
  sender: PublicSender;
  consignee: PublicAddress;
  onSender: (next: PublicSender) => void;
  onConsignee: (next: PublicAddress) => void;
  errors: Record<string, string>;
  revealErrors?: boolean;
  csbType: "CSB_IV" | "CSB_V";
};

function EntityChoice({
  value,
  onChange,
  name,
}: {
  value: "INDIVIDUAL" | "COMPANY";
  onChange: (value: "INDIVIDUAL" | "COMPANY") => void;
  name: string;
}) {
  return (
    <fieldset>
      <legend className="text-sm font-semibold text-slate-600">
        Booking as
      </legend>
      <div className="mt-1.5 grid grid-cols-2 gap-2">
        {(["INDIVIDUAL", "COMPANY"] as const).map((option) => (
          <label
            key={option}
            className={`flex h-11 items-center justify-center rounded-lg border text-sm font-semibold transition ${value === option ? "border-[#0D1282] bg-[#0D1282]/5 text-[#0D1282]" : "border-slate-300 bg-white text-slate-600 hover:border-slate-400"}`}
          >
            <input
              type="radio"
              className="sr-only"
              name={name}
              checked={value === option}
              onChange={() => onChange(option)}
            />
            {option === "INDIVIDUAL" ? "Individual" : "Company"}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function AddressPanel<T extends PublicAddress>({
  title,
  eyebrow,
  value,
  onChange,
  sender,
  errors,
  revealErrors = false,
  prefix,
  csbType,
}: {
  title: string;
  eyebrow: string;
  value: T;
  onChange: (next: T) => void;
  sender?: boolean;
  errors: Record<string, string>;
  revealErrors?: boolean;
  prefix: string;
  csbType: "CSB_IV" | "CSB_V";
}) {
  const [states, setStates] = useState<GeographyState[]>([]);
  const [cities, setCities] = useState<string[]>([]);
  const update = (key: keyof PublicSender, next: string) =>
    onChange({ ...value, [key]: next } as T);
  const stateCode = findStateCode(states, value.county);

  useEffect(() => {
    let current = true;
    void fetchStates(value.countryName, PUBLIC_REFERENCE_ROOT).then((items) => {
      if (current) setStates(items);
    });
    return () => {
      current = false;
    };
  }, [value.countryName]);
  useEffect(() => {
    let current = true;
    if (!stateCode)
      return () => {
        current = false;
      };
    void fetchCities(value.countryName, stateCode, PUBLIC_REFERENCE_ROOT).then(
      (items) => {
        if (current) setCities(items);
      },
    );
    return () => {
      current = false;
    };
  }, [stateCode, value.countryName]);

  const countryOptions = useMemo(
    () =>
      countryCodeOptions
        .filter((country) => sender || country.code !== "IN")
        .map((country) => ({
          value: country.code,
          label: country.name,
          iso2: country.code.toLowerCase(),
        })),
    [sender],
  );
  const report = (key: string) => {
    const message = errors[`${prefix}.${key}`];
    if (message)
      toast.error(message, { toastId: `${prefix}.${key}:${message}` });
  };

  return (
    <section
      aria-labelledby={`${prefix}-heading`}
      className="min-w-0 overflow-hidden rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6"
    >
      <div className="-mx-5 -mt-5 mb-5 flex items-center gap-4 border-b border-[#D8E2FF] bg-[#de2407f9] px-5 py-6 sm:-mx-6 sm:-mt-6 sm:mb-6 sm:px-6">
        <h2
          id={`${prefix}-heading`}
          className="text-lg font-bold tracking-tight  sm:text-xl"
        >
          <span className="text-[#dfd5d5]">{eyebrow}</span>
          <span className="ml-2 text-[#ffffff]">{title}</span>
        </h2>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <EntityChoice
            name={`${prefix}-entity`}
            value={value.entityType}
            onChange={(entityType) => onChange({ ...value, entityType } as T)}
          />
        </div>
        <div className="sm:col-span-2">
          <BookingField
            label="Company Name"
            required={value.entityType === "COMPANY"}
            value={value.companyName}
            onChange={(event) => update("companyName", event.target.value)}
            revealError={revealErrors}
            error={errors[`${prefix}.companyName`]}
            autoComplete="organization"
          />
        </div>
        <BookingField
          label="Contact Name"
          required
          value={value.contactName}
          onChange={(event) => update("contactName", event.target.value)}
          revealError={revealErrors}
          error={errors[`${prefix}.contactName`]}
          autoComplete="name"
        />
        <BookingField
          label="Email"
          required
          type="email"
          value={value.email}
          onChange={(event) => update("email", event.target.value)}
          revealError={revealErrors}
          error={errors[`${prefix}.email`]}
          autoComplete="email"
        />
        {sender ? (
          <PublicFixedCountryField label="Mobile Country Code" mode="dial" />
        ) : (
          <PublicPhoneCodeField
            value={value.mobileCountryCode}
            onChange={(next) => update("mobileCountryCode", next)}
            error={
              errors[`${prefix}.mobileCountryCode`] ||
              errors[`${prefix}.mobileNumber`]
            }
            defaultDialCode="+44"
          />
        )}
        <BookingField
          label="Mobile Number"
          required
          inputMode="numeric"
          value={value.mobileNumber}
          onChange={(event) =>
            update(
              "mobileNumber",
              event.target.value.replace(/\D/g, "").slice(0, sender ? 10 : 14),
            )
          }
          revealError={revealErrors}
          error={errors[`${prefix}.mobileNumber`]}
          autoComplete="tel-national"
        />
        {sender ? (
          <PublicFixedCountryField label="Country" />
        ) : (
          <PublicSearchableSelect
            label="Country"
            required
            value={value.countryCode}
            options={countryOptions}
            error={errors[`${prefix}.countryCode`]}
            revealError={revealErrors}
            placeholder="Search destination country"
            onChange={(countryCode) => {
              const country = countryCodeOptions.find(
                (item) => item.code === countryCode,
              );
              // Keep the receiver dial code on the destination's code: a code
              // from another country is invalid for this lane anyway.
              const dialCode = getDialCodeForCountryCode(countryCode);
              onChange({
                ...value,
                countryCode,
                countryName: country?.name ?? "",
                county: "",
                stateCode: "",
                townOrCity: "",
                postcode: "",
                ...(dialCode ? { mobileCountryCode: dialCode } : null),
              } as T);
            }}
          />
        )}
        <BookingField
          label={sender ? "PIN Code" : "Postal Code"}
          required
          inputMode={sender ? "numeric" : "text"}
          value={value.postcode}
          onChange={(event) =>
            update(
              "postcode",
              sender
                ? event.target.value.replace(/\D/g, "").slice(0, 6)
                : event.target.value.toUpperCase().slice(0, 20),
            )
          }
          revealError={revealErrors}
          error={errors[`${prefix}.postcode`]}
          autoComplete="postal-code"
        />
        <div className="sm:col-span-2" onBlur={() => report("addressLine1")}>
          <PublicAddressAutocompleteField
            label="Address Line 1"
            required
            value={value.addressLine1}
            countryName={value.countryName}
            endpointRoot={PUBLIC_ADDRESS_ROOT}
            revealError={revealErrors}
            error={errors[`${prefix}.addressLine1`]}
            onChange={(next) => update("addressLine1", next)}
            onAddressSelected={(address) => {
              const matchedState =
                matchStateName(states, address.state) || address.state;
              onChange({
                ...value,
                addressLine1: address.addressLine1,
                addressLine2: address.addressLine2,
                townOrCity: address.city,
                county: matchedState,
                stateCode: findStateCode(states, matchedState),
                postcode: address.postalCode.toUpperCase(),
                countryCode: address.countryCode || value.countryCode,
                countryName: address.countryName || value.countryName,
              } as T);
              toast.success("Address selected and fields filled.", {
                toastId: `${prefix}-address-selected`,
              });
            }}
          />
        </div>
        <div className="sm:col-span-2">
          <BookingField
            label="Address Line 2"
            value={value.addressLine2}
            onChange={(event) => update("addressLine2", event.target.value)}
            autoComplete="address-line2"
          />
        </div>
        {states.length ? (
          <PublicSearchableSelect
            label="State / County"
            required
            value={value.county}
            options={states.map((state) => ({
              value: state.name,
              label: state.name,
            }))}
            error={errors[`${prefix}.county`]}
            revealError={revealErrors}
            placeholder="Search state"
            onChange={(next) =>
              onChange({
                ...value,
                county: next,
                stateCode: findStateCode(states, next),
                // Preserve a city entered before the first state selection or
                // filled by address lookup. Clear it only when the user changes
                // from one established state to another.
                townOrCity:
                  value.county && value.county !== next
                    ? ""
                    : value.townOrCity,
              } as T)
            }
          />
        ) : (
          <BookingField
            label="State / County"
            required
            value={value.county}
            onChange={(event) => update("county", event.target.value)}
            revealError={revealErrors}
            error={errors[`${prefix}.county`]}
            autoComplete="address-level1"
          />
        )}
        {stateCode && cities.length ? (
          <PublicSearchableSelect
            label="Town / City"
            required
            value={value.townOrCity}
            options={cities.map((city) => ({ value: city, label: city }))}
            error={errors[`${prefix}.townOrCity`]}
            revealError={revealErrors}
            placeholder="Search city"
            onChange={(next) => update("townOrCity", next)}
          />
        ) : (
          <BookingField
            label="Town / City"
            required
            value={value.townOrCity}
            onChange={(event) => update("townOrCity", event.target.value)}
            revealError={revealErrors}
            error={errors[`${prefix}.townOrCity`]}
            autoComplete="address-level2"
          />
        )}
        {!sender && csbType === "CSB_V" ? (
          <BookingField
            label="Consignee State Code"
            required
            value={value.stateCode}
            readOnly={Boolean(states.length)}
            onChange={(event) => update("stateCode", event.target.value.toUpperCase())}
            error={errors[`${prefix}.stateCode`]}
            revealError={revealErrors}
          />
        ) : null}
        {sender ? (
          <div className="sm:col-span-2">
            <BookingField
              label="Aadhaar Number"
              required
              inputMode="numeric"
              maxLength={14}
              value={formatAadhaarNumber(
                "aadhaarNumber" in value &&
                  typeof value.aadhaarNumber === "string"
                  ? value.aadhaarNumber
                  : "",
              )}
              onChange={(event) =>
                update(
                  "aadhaarNumber",
                  normalizeAadhaarNumber(event.target.value),
                )
              }
              revealError={revealErrors}
              error={errors[`${prefix}.aadhaarNumber`]}
              aria-describedby={`${prefix}-aadhaar-help`}
            />
            <span
              id={`${prefix}-aadhaar-help`}
              className="mt-1 block text-xs text-slate-500"
            >
              Stored securely and masked in booking summaries and emails.
            </span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export default function AddressStep(props: Props) {
  return (
    <div className="grid items-start gap-5 lg:grid-cols-2">
      <AddressPanel
        title="Sender Details"
        eyebrow="From"
        value={props.sender}
        onChange={props.onSender}
        sender
        errors={props.errors}
        revealErrors={props.revealErrors}
        prefix="sender"
        csbType={props.csbType}
      />
      <AddressPanel
        title="Receiver Details"
        eyebrow="To"
        value={props.consignee}
        onChange={props.onConsignee}
        errors={props.errors}
        revealErrors={props.revealErrors}
        prefix="consignee"
        csbType={props.csbType}
      />
    </div>
  );
}
