// @vitest-environment jsdom
/**
 * The in-app half of "location and internet are required".
 *
 * What matters here is restraint as much as coverage. This banner sits at the
 * top of the screen an employee looks at every morning, so it has to be right
 * about three things: appear when a setting is genuinely breaking attendance,
 * say which one and open it, and disappear the moment it is fixed — including
 * the browser case, where the device's location toggle cannot be read at all and
 * a guess would warn everyone working indoors.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({
  network: "wifi" as string,
  status: {
    supported: true,
    manufacturer: "OnePlus",
    model: "Nord 5",
    batteryUnrestricted: true,
    autostartScreenAvailable: false,
    trackingServiceRunning: true,
    locationServicesEnabled: true,
    internetAvailable: true,
  },
  permission: "granted" as string,
  opened: [] as string[],
  opensOk: true,
  networkListener: null as ((t: string) => void) | null,
}));

vi.mock("@/lib/device-status", () => ({
  readNetworkType: vi.fn(async () => h.network),
  subscribeNetwork: vi.fn(async (cb: (t: string) => void) => {
    h.networkListener = cb;
    return () => {
      h.networkListener = null;
    };
  }),
}));

vi.mock("@/lib/device-setup", () => ({
  getDeviceSetupStatus: vi.fn(async () => h.status),
  openLocationSettings: vi.fn(async () => {
    h.opened.push("location");
    return h.opensOk;
  }),
  openNetworkSettings: vi.fn(async () => {
    h.opened.push("network");
    return h.opensOk;
  }),
  openAppSettings: vi.fn(async () => {
    h.opened.push("app");
    return h.opensOk;
  }),
}));

vi.mock("@/lib/device-connectivity", async (orig) => {
  const actual = (await orig()) as any;
  return { ...actual, readLocationPermission: vi.fn(async () => h.permission) };
});

vi.mock("@/components/ui/toaster", () => ({ toast: vi.fn() }));

import { ConnectivityAlert } from "@/components/geo/ConnectivityAlert";

beforeEach(() => {
  h.network = "wifi";
  h.status = {
    supported: true,
    manufacturer: "OnePlus",
    model: "Nord 5",
    batteryUnrestricted: true,
    autostartScreenAvailable: false,
    trackingServiceRunning: true,
    locationServicesEnabled: true,
    internetAvailable: true,
  };
  h.permission = "granted";
  h.opened = [];
  h.opensOk = true;
  h.networkListener = null;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ConnectivityAlert", () => {
  it("renders nothing when location and internet are both fine", async () => {
    const { container } = render(<ConnectivityAlert enabled />);
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("warns that attendance is NOT being recorded when location is off", async () => {
    h.status = { ...h.status, locationServicesEnabled: false };
    render(<ConnectivityAlert enabled />);
    expect(await screen.findByText(/Turn on location/i)).toBeTruthy();
    expect(screen.getByText(/isn't being recorded/i)).toBeTruthy();
  });

  it("is calmer about no internet, because nothing is lost", async () => {
    h.network = "offline";
    render(<ConnectivityAlert enabled />);
    expect(await screen.findByText(/No internet connection/i)).toBeTruthy();
    // Must NOT claim the shift is going unrecorded — the pings are queued.
    expect(screen.queryByText(/isn't being recorded/i)).toBeNull();
    expect(screen.getByText(/sync when you're back online/i)).toBeTruthy();
  });

  it("stays silent in a browser, where the location toggle cannot be read", async () => {
    // supported:false is the web path. Warning here would fire for every
    // employee whose phone simply has no fix indoors.
    h.status = { ...h.status, supported: false, locationServicesEnabled: false };
    const { container } = render(<ConnectivityAlert enabled />);
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("stays silent outside the shift window", async () => {
    // Everything is wrong, but none of it matters at midnight on a day off.
    h.status = { ...h.status, locationServicesEnabled: false };
    h.network = "offline";
    const { container } = render(<ConnectivityAlert enabled={false} />);
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("opens the location screen, not the network one, when both are off", async () => {
    h.status = { ...h.status, locationServicesEnabled: false };
    h.network = "offline";
    const user = userEvent.setup();
    render(<ConnectivityAlert enabled />);
    await user.click(await screen.findByRole("button", { name: /fix/i }));
    // Location is the one destroying data; the network usually returns on its own.
    await waitFor(() => expect(h.opened).toEqual(["location"]));
  });

  it("opens the app's own settings for a denied permission", async () => {
    h.permission = "denied";
    const user = userEvent.setup();
    render(<ConnectivityAlert enabled />);
    await user.click(await screen.findByRole("button", { name: /fix/i }));
    await waitFor(() => expect(h.opened).toEqual(["app"]));
  });

  it("opens network settings when only the connection is down", async () => {
    h.network = "offline";
    const user = userEvent.setup();
    render(<ConnectivityAlert enabled />);
    await user.click(await screen.findByRole("button", { name: /fix/i }));
    await waitFor(() => expect(h.opened).toEqual(["network"]));
  });

  it("says where to go when there is no settings screen to open", async () => {
    h.network = "offline";
    h.opensOk = false;
    const user = userEvent.setup();
    const { toast } = await import("@/components/ui/toaster");
    render(<ConnectivityAlert enabled />);
    await user.click(await screen.findByRole("button", { name: /fix/i }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringMatching(/device settings/i) })
      )
    );
  });

  it("clears itself the moment the connection returns", async () => {
    h.network = "offline";
    const { container } = render(<ConnectivityAlert enabled />);
    await screen.findByText(/No internet connection/i);

    // The live network listener, which is how this actually resolves in the field.
    await waitFor(() => expect(h.networkListener).not.toBeNull());
    h.networkListener!("wifi");
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("announces a problem once, not on every render", async () => {
    h.status = { ...h.status, locationServicesEnabled: false };
    const { toast } = await import("@/components/ui/toaster");
    const { rerender } = render(<ConnectivityAlert enabled />);
    await screen.findByText(/Turn on location/i);
    rerender(<ConnectivityAlert enabled />);
    rerender(<ConnectivityAlert enabled />);
    // The banner is persistent; the toast is an interruption and gets one turn.
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
  });

  it("interrupts for a data-losing problem and merely mentions a recoverable one", async () => {
    const { toast } = await import("@/components/ui/toaster");

    h.status = { ...h.status, locationServicesEnabled: false };
    render(<ConnectivityAlert enabled />);
    await screen.findByText(/Turn on location/i);
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: "destructive" })
      )
    );

    cleanup();
    vi.clearAllMocks();
    h.status = { ...h.status, locationServicesEnabled: true };
    h.network = "offline";
    render(<ConnectivityAlert enabled />);
    await screen.findByText(/No internet connection/i);
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "default" }))
    );
  });
});
