/**
 * The two switches that silently break attendance.
 *
 * The point of these tests is the DIFFERENCE between the two failures. Location
 * off destroys data; internet off only delays it. Presenting them identically
 * would be wrong in both directions — either crying wolf about a queue that is
 * about to drain, or shrugging at a shift that is recording nothing.
 */
import { describe, it, expect } from "vitest";
import { describeConnectivityProblem, type ConnectivityInput } from "@/lib/device-connectivity";

const HEALTHY: ConnectivityInput = {
  online: true,
  locationEnabled: true,
  locationPermission: "granted",
};

describe("describeConnectivityProblem", () => {
  it("says nothing when everything works", () => {
    expect(describeConnectivityProblem(HEALTHY)).toBeNull();
  });

  it("treats location off as losing data", () => {
    const p = describeConnectivityProblem({ ...HEALTHY, locationEnabled: false });
    expect(p?.id).toBe("location-off");
    expect(p?.losingData).toBe(true);
    expect(p?.fix).toBe("location");
  });

  it("treats no internet as a delay, NOT a loss", () => {
    // Capture continues and the pings queue on the device; the only thing lost
    // is timeliness. Calling this "your attendance isn't being recorded" would
    // be a lie, and one that makes the real warning ignorable.
    const p = describeConnectivityProblem({ ...HEALTHY, online: false });
    expect(p?.id).toBe("internet-off");
    expect(p?.losingData).toBe(false);
    expect(p?.message).toMatch(/sync/i);
  });

  it("reports both when both are off, and points at location first", () => {
    const p = describeConnectivityProblem({ ...HEALTHY, online: false, locationEnabled: false });
    expect(p?.id).toBe("location-and-internet");
    expect(p?.losingData).toBe(true);
    // Location is the one destroying data, so that is the setting to open.
    expect(p?.fix).toBe("location");
  });

  it("reports a denied permission ahead of the device toggle", () => {
    // While the app may not read location, whether the device switch is on
    // changes nothing — sending someone to the wrong screen wastes the one
    // moment they were willing to act.
    const p = describeConnectivityProblem({
      online: true,
      locationEnabled: false,
      locationPermission: "denied",
    });
    expect(p?.id).toBe("location-permission");
    expect(p?.fix).toBe("permission");
  });

  it("reports the permission even when the device toggle is on", () => {
    const p = describeConnectivityProblem({ ...HEALTHY, locationPermission: "denied" });
    expect(p?.id).toBe("location-permission");
    expect(p?.losingData).toBe(true);
  });

  it("stays silent when the location state cannot be read", () => {
    // The browser case: there is no API for the device's location toggle, and a
    // failed fix indoors looks identical to one that is switched off. Guessing
    // here would warn every employee working in a warehouse.
    expect(describeConnectivityProblem({ ...HEALTHY, locationEnabled: null })).toBeNull();
  });

  it("stays silent when the permission is unknown or merely unasked", () => {
    for (const locationPermission of ["unknown", "prompt"] as const) {
      expect(describeConnectivityProblem({ ...HEALTHY, locationPermission })).toBeNull();
    }
  });

  it("still reports no internet when the location state is unreadable", () => {
    // Unknown location must not suppress the network warning: they are
    // independent, and this is the browser's normal state.
    const p = describeConnectivityProblem({ ...HEALTHY, locationEnabled: null, online: false });
    expect(p?.id).toBe("internet-off");
  });

  it("gives every problem something actionable to say", () => {
    const inputs: ConnectivityInput[] = [
      { ...HEALTHY, locationEnabled: false },
      { ...HEALTHY, online: false },
      { ...HEALTHY, online: false, locationEnabled: false },
      { ...HEALTHY, locationPermission: "denied" },
    ];
    for (const input of inputs) {
      const p = describeConnectivityProblem(input)!;
      expect(p.title.length, JSON.stringify(input)).toBeGreaterThan(0);
      // A warning that does not say what to do is just noise.
      expect(p.message.length).toBeGreaterThan(20);
      expect(p.fix).not.toBeNull();
    }
  });

  it("never claims data is being lost while location is working", () => {
    // Guards the severity rule as a whole: losingData is exactly "location is
    // not being captured", never "the upload is behind".
    for (const online of [true, false]) {
      const p = describeConnectivityProblem({ ...HEALTHY, online });
      expect(p?.losingData ?? false).toBe(false);
    }
  });
});
