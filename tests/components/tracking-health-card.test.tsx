// @vitest-environment jsdom
/**
 * The one failure an employee cannot otherwise see.
 *
 * Every other problem surfaces somehow — a rejected check-in says why, a lost
 * network shows a badge. A phone that quietly kills the tracking service shows
 * nothing: the shift records no location and nobody finds out until an admin
 * reads a report days later.
 *
 * The card must therefore appear when it matters and stay out of the way when it
 * does not — a warning shown to correctly configured devices trains people to
 * dismiss it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  status: {
    supported: true,
    manufacturer: "OnePlus",
    model: "Nord 5",
    batteryUnrestricted: false,
    autostartScreenAvailable: true,
    trackingServiceRunning: true,
  },
  batteryOpened: 0,
  autostartOpened: 0,
  batteryOpensOk: true,
}));

vi.mock("@/lib/device-setup", async (orig) => {
  const actual = (await orig()) as any;
  return {
    ...actual,
    getDeviceSetupStatus: vi.fn(async () => h.status),
    requestBatteryExemption: vi.fn(async () => {
      h.batteryOpened++;
      return h.batteryOpensOk;
    }),
    openAutostartSettings: vi.fn(async () => {
      h.autostartOpened++;
      return true;
    }),
  };
});
vi.mock("@/components/ui/toaster", () => ({ toast: vi.fn() }));

import { TrackingHealthCard } from "@/components/geo/TrackingHealthCard";

beforeEach(() => {
  h.status = {
    supported: true,
    manufacturer: "OnePlus",
    model: "Nord 5",
    batteryUnrestricted: false,
    autostartScreenAvailable: true,
    trackingServiceRunning: true,
  };
  h.batteryOpened = 0;
  h.autostartOpened = 0;
  h.batteryOpensOk = true;
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TrackingHealthCard", () => {
  it("warns when the device will kill background tracking", async () => {
    render(<TrackingHealthCard />);
    expect(await screen.findByText(/may stop tracking you/i)).toBeTruthy();
    expect(screen.getByText(/OnePlus/)).toBeTruthy();
  });

  it("renders NOTHING on web", async () => {
    // A warning on a platform with no such setting is pure noise.
    h.status = { ...h.status, supported: false };
    const { container } = render(<TrackingHealthCard />);
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("renders nothing once the device is configured correctly", async () => {
    h.status = { ...h.status, batteryUnrestricted: true, autostartScreenAvailable: false };
    const { container } = render(<TrackingHealthCard />);
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("opens the battery dialog", async () => {
    const user = userEvent.setup();
    render(<TrackingHealthCard />);
    await user.click(await screen.findByRole("button", { name: /fix/i }));
    expect(h.batteryOpened).toBe(1);
  });

  it("opens the autostart screen and stops asking afterwards", async () => {
    // Autostart cannot be read back, so the employee's confirmation is the only
    // signal available — asking again every visit would be nagging.
    const user = userEvent.setup();
    render(<TrackingHealthCard />);
    await user.click(await screen.findByRole("button", { name: /open/i }));
    expect(h.autostartOpened).toBe(1);

    await waitFor(() =>
      expect(screen.queryByText(/start automatically/i)).toBeNull()
    );
    expect(window.localStorage.getItem("swaya-autostart-confirmed")).toBe("1");
  });

  it("shows brand-specific wording", async () => {
    h.status = { ...h.status, manufacturer: "Xiaomi" };
    render(<TrackingHealthCard />);
    expect(await screen.findByText(/Turn on "Autostart"/)).toBeTruthy();
  });

  it("only asks about battery when autostart is already dealt with", async () => {
    window.localStorage.setItem("swaya-autostart-confirmed", "1");
    render(<TrackingHealthCard />);
    expect(await screen.findByText(/background battery use/i)).toBeTruthy();
    expect(screen.queryByText(/start automatically/i)).toBeNull();
  });

  it("explains the manual route when the dialog cannot be opened", async () => {
    h.batteryOpensOk = false;
    const user = userEvent.setup();
    const { toast } = await import("@/components/ui/toaster");
    render(<TrackingHealthCard />);
    await user.click(await screen.findByRole("button", { name: /fix/i }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
  });
});
