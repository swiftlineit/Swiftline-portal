"use client";

import { ChangeEvent, useEffect, useMemo, useState } from "react";
import { ShipmentSelectField, ShipmentTextField } from "@/components/shipments/ShipmentFormControls";
import { fetchStates, findShipmentStateCode, findStateCode, type GeographyState } from "@/lib/geography";

export function ShipmentConsigneeStateFields({
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
  const [loadedStates, setLoadedStates] = useState<{ countryName: string; states: GeographyState[] } | null>(null);
  const states = useMemo(
    () => loadedStates?.countryName === countryName ? loadedStates.states : [],
    [countryName, loadedStates]
  );

  useEffect(() => {
    let active = true;
    void fetchStates(countryName).then((nextStates) => {
      if (active) setLoadedStates({ countryName, states: nextStates });
    });
    return () => { active = false; };
  }, [countryName]);

  useEffect(() => {
    if (!requiredStateCode || !states.length || !state) return;

    const referenceCode = findStateCode(states, state);
    const nextCode = findShipmentStateCode(countryName, states, state);
    // Fill legacy drafts that have no code, or convert the old ISO code to the
    // numeric CSB-V code. Preserve a user-edited value afterwards.
    if (nextCode && (!stateCode || stateCode === referenceCode) && nextCode !== stateCode) {
      onStateCodeChange(nextCode);
    }
  }, [countryName, onStateCodeChange, requiredStateCode, state, stateCode, states]);

  const handleStateChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextState = event.target.value;
    onStateChange(nextState);

    const nextCode = findShipmentStateCode(countryName, states, nextState);
    if (requiredStateCode && nextCode) onStateCodeChange(nextCode);
  };

  const handleManualStateCodeChange = (event: ChangeEvent<HTMLInputElement>) => {
    onStateCodeChange(event.target.value.toUpperCase());
  };

  return (
    <>
      {states.length ? (
        <ShipmentSelectField
          label="Delivery State / County"
          value={state}
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
          inputMode="numeric"
          maxLength={20}
          hint={states.length ? "Filled automatically from the selected state; you can edit it if needed." : "Enter the numeric state code from the reference data."}
        />
      ) : null}
    </>
  );
}
