"use client";

import { ChangeEvent, useEffect, useMemo, useState } from "react";
import { ShipmentSelectField, ShipmentTextField } from "@/components/shipments/ShipmentFormControls";
import { resolveCountry } from "@/lib/countryLookup";
import { fetchStates, findShipmentStateCode, findStateCode, matchStateName, type GeographyState } from "@/lib/geography";

export function ShipmentConsigneeStateFields({
  countryCode,
  countryName,
  state,
  stateCode,
  onStateChange,
  onStateCodeChange,
  requiredStateCode,
  stateError,
  stateCodeError,
  revealError
}: {
  countryCode: string;
  countryName: string;
  state: string;
  stateCode: string;
  onStateChange: (value: string) => void;
  onStateCodeChange: (value: string) => void;
  requiredStateCode: boolean;
  stateError?: string;
  stateCodeError?: string;
  revealError: boolean;
}) {
  const lookupCountry = countryCode.trim() || countryName;
  const resolvedCountry = resolveCountry(lookupCountry);
  const countryKey = resolvedCountry?.iso2.toUpperCase() ?? lookupCountry.trim().toLowerCase();
  const isUnitedStates = countryKey === "US";
  const [loadedStates, setLoadedStates] = useState<{ countryKey: string; states: GeographyState[] } | null>(null);
  const states = useMemo(
    () => loadedStates && loadedStates.countryKey === countryKey ? loadedStates.states : [],
    [countryKey, loadedStates]
  );
  // MongoDB stores this address field uppercased, while the reference options
  // use title case. Keep the controlled select pointed at the canonical option
  // so a saved value such as "OHIO" never renders as an empty selection.
  const selectedStateName = states.length ? matchStateName(states, state) || state : state;
  const numericStateCode = isUnitedStates && /^\d+$/.test(findShipmentStateCode(lookupCountry, states, selectedStateName));

  useEffect(() => {
    let active = true;
    void fetchStates(lookupCountry).then((nextStates) => {
      if (active) setLoadedStates({ countryKey, states: nextStates });
    });
    return () => { active = false; };
  }, [countryKey, lookupCountry]);

  useEffect(() => {
    if (!requiredStateCode || !states.length || !state) return;

    const referenceCode = findStateCode(states, selectedStateName);
    const nextCode = findShipmentStateCode(lookupCountry, states, selectedStateName);
    // Fill legacy drafts that have no code, or convert the old ISO code to the
    // numeric CSB-V code. Preserve a user-edited value afterwards.
    if (nextCode && (!stateCode || stateCode === referenceCode) && nextCode !== stateCode) {
      onStateCodeChange(nextCode);
    }
  }, [lookupCountry, onStateCodeChange, requiredStateCode, selectedStateName, state, stateCode, states]);

  const handleStateChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextState = event.target.value;
    onStateChange(nextState);

    const nextCode = findShipmentStateCode(lookupCountry, states, nextState);
    if (requiredStateCode && nextCode) onStateCodeChange(nextCode);
  };

  const handleManualStateCodeChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextValue = numericStateCode
      ? event.target.value.replace(/\D/g, "")
      : event.target.value.toUpperCase();
    onStateCodeChange(nextValue);
  };

  return (
    <>
      {states.length ? (
        <ShipmentSelectField
          label="Delivery State / County"
          value={selectedStateName}
          onChange={handleStateChange}
          error={stateError}
          revealError={revealError}
          required
        >
          <option value="">Select state</option>
          {states.map((option) => <option key={option.code || option.name} value={option.name}>{option.name}</option>)}
        </ShipmentSelectField>
      ) : (
        <ShipmentTextField
          label="Delivery State / County"
          value={state}
          onChange={(event) => onStateChange(event.target.value.toUpperCase())}
          error={stateError}
          revealError={revealError}
          required
          maxLength={80}
        />
      )}
      {requiredStateCode ? (
        <ShipmentTextField
          label="Consignee State Code"
          value={stateCode}
          onChange={handleManualStateCodeChange}
          error={stateCodeError}
          revealError={revealError}
          required
          inputMode={numericStateCode ? "numeric" : "text"}
          maxLength={20}
          hint={states.length ? "Filled automatically from the selected state; you can edit it if needed." : "Enter the state code from the reference data."}
        />
      ) : null}
    </>
  );
}
