import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  flightArrivalDateTimeLocalToIso,
  flightArrivalTimeZoneLabel,
  formatFlightArrivalDateTime,
  formatUkDateTime,
  isUkFlightDestination,
  isoToFlightArrivalDateTimeLocal,
  isoToUkDateTimeLocal,
  ukDateTimeLocalToIso,
} from "./dateTimeZones";
import { indiaDateTimeLocalToIso } from "./indiaDateTime";

describe("UK flight schedule timezone conversion", () => {
  it("converts the Oct 6 UK arrival from BST to UTC and formats it back", () => {
    const departure = indiaDateTimeLocalToIso("2026-10-06T00:55");
    const arrival = ukDateTimeLocalToIso("2026-10-06T07:30");

    assert.equal(departure, "2026-10-05T19:25:00.000Z");
    assert.equal(arrival, "2026-10-06T06:30:00.000Z");
    assert.ok(new Date(arrival).getTime() > new Date(departure).getTime());
    assert.equal(isoToUkDateTimeLocal(arrival), "2026-10-06T07:30");
    assert.equal(formatUkDateTime(arrival), "6 Oct 2026, 7:30 am");
  });

  it("uses GMT for winter arrival times", () => {
    assert.equal(
      ukDateTimeLocalToIso("2026-01-06T07:30"),
      "2026-01-06T07:30:00.000Z",
    );
  });

  it("rejects skipped and repeated wall times at UK daylight-saving changes", () => {
    assert.equal(ukDateTimeLocalToIso("2026-03-29T01:30"), "");
    assert.equal(ukDateTimeLocalToIso("2026-10-25T01:30"), "");
  });

  it("rejects invalid calendar dates", () => {
    assert.equal(ukDateTimeLocalToIso("2026-02-30T07:30"), "");
  });

  it("uses UK local time for UK destination airports and keeps IST for non-UK destinations", () => {
    const ukArrivalUtc = "2026-10-06T06:30:00.000Z";
    const indiaArrivalUtc = indiaDateTimeLocalToIso("2026-10-06T07:30");

    for (const airportCode of ["LHR", "LGW", "STN", "LTN", "LCY", "SEN"]) {
      assert.equal(isUkFlightDestination(airportCode), true, `${airportCode} should use UK local time`);
    }
    assert.equal(isUkFlightDestination("lhr"), true);
    assert.equal(isUkFlightDestination("JFK"), false);
    assert.equal(flightArrivalTimeZoneLabel("LHR"), "UK time");
    assert.equal(flightArrivalTimeZoneLabel("JFK"), "IST");

    assert.equal(isoToFlightArrivalDateTimeLocal(ukArrivalUtc, "LHR"), "2026-10-06T07:30");
    assert.equal(flightArrivalDateTimeLocalToIso("2026-10-06T07:30", "LHR"), ukArrivalUtc);
    assert.equal(isoToFlightArrivalDateTimeLocal(indiaArrivalUtc, "JFK"), "2026-10-06T07:30");
    assert.equal(flightArrivalDateTimeLocalToIso("2026-10-06T07:30", "JFK"), indiaArrivalUtc);
    assert.equal(formatFlightArrivalDateTime(ukArrivalUtc, "LHR"), "6 Oct 2026, 7:30 am");
    assert.equal(formatFlightArrivalDateTime(indiaArrivalUtc, "JFK"), "6/10/2026, 7:30:00 am");
  });
});
