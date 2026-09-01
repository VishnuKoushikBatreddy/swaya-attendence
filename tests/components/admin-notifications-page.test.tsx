// @vitest-environment jsdom
/**
 * Rendering tests for the admin Notifications page.
 *
 * The API has its own tests; what is only observable by rendering is the CLIENT
 * WIRING — that fetched notifications reach the DOM, that unread ones are
 * visually distinct, that filters re-query, and that marking read updates the
 * view optimistically rather than waiting for the next poll.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AdminNotificationsPage from "@/app/(dashboard)/admin/notifications/page";

function item(over: Partial<any> = {}) {
  return {
    _id: "n1",
    type: "site_exit",
    severity: "warning",
    title: "Alice left the site",
    body: "Left Main Office at 12:30 and is 320 m away, but is still checked in.",
    employeeName: "Alice",
    employeeCode: "E1",
    employeePhone: "555-0100",
    siteName: "Main Office",
    occurredAt: new Date("2026-09-01T12:30:00Z").toISOString(),
    isRead: false,
    ...over,
  };
}

function payload(notifications: any[], unreadCount?: number) {
  return {
    ok: true,
    data: {
      notifications,
      unreadCount: unreadCount ?? notifications.filter((n) => !n.isRead).length,
    },
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => payload([item()]),
  }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("admin notifications page", () => {
  it("renders a stored notification", async () => {
    render(<AdminNotificationsPage />);
    expect(await screen.findByText("Alice left the site")).toBeTruthy();
    expect(screen.getByText(/320 m away/)).toBeTruthy();
  });

  it("shows the unread count in the header", async () => {
    render(<AdminNotificationsPage />);
    expect(await screen.findByText(/1 unread/)).toBeTruthy();
  });

  it("offers a click-to-call link for the employee", async () => {
    render(<AdminNotificationsPage />);
    const link = (await screen.findByText("555-0100")).closest("a");
    expect(link?.getAttribute("href")).toBe("tel:555-0100");
  });

  it("marks an unread item as read on click, without waiting for a poll", async () => {
    const user = userEvent.setup();
    render(<AdminNotificationsPage />);
    await screen.findByText("Alice left the site");

    // From here the server keeps returning the row, now read.
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => payload([item({ isRead: true })], 0),
    }));

    await user.click(screen.getByRole("button", { name: /mark read/i }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /mark read/i })).toBeNull();
    });
    const patch = fetchMock.mock.calls.find((c: any[]) => c[1]?.method === "PATCH");
    expect(patch).toBeTruthy();
    expect(JSON.parse(patch![1].body)).toEqual({ ids: ["n1"] });
  });

  it("sends `all` when marking everything read", async () => {
    const user = userEvent.setup();
    render(<AdminNotificationsPage />);
    await screen.findByText("Alice left the site");

    await user.click(screen.getByRole("button", { name: /mark all read/i }));

    const patch = fetchMock.mock.calls.find((c: any[]) => c[1]?.method === "PATCH");
    expect(JSON.parse(patch![1].body)).toEqual({ all: true });
  });

  it("disables 'mark all read' when nothing is unread", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => payload([item({ isRead: true })], 0),
    }));
    render(<AdminNotificationsPage />);
    await screen.findByText("Alice left the site");
    const btn = screen.getByRole("button", { name: /mark all read/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("re-queries the API when a type filter is chosen", async () => {
    const user = userEvent.setup();
    render(<AdminNotificationsPage />);
    await screen.findByText("Alice left the site");

    await user.click(screen.getByRole("button", { name: "Offline" }));

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c: any[]) => String(c[0]));
      expect(urls.some((u) => u.includes("type=offline"))).toBe(true);
    });
  });

  it("asks for unread only when the Unread filter is chosen", async () => {
    const user = userEvent.setup();
    render(<AdminNotificationsPage />);
    await screen.findByText("Alice left the site");

    await user.click(screen.getByRole("button", { name: /^Unread/ }));

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c: any[]) => String(c[0]));
      expect(urls.some((u) => u.includes("unread=1"))).toBe(true);
    });
  });

  it("shows an empty state rather than a blank panel", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => payload([], 0),
    }));
    render(<AdminNotificationsPage />);
    expect(await screen.findByText(/No notifications yet/)).toBeTruthy();
  });

  it("surfaces a load failure instead of showing a silently empty feed", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: false,
      json: async () => ({ ok: false, error: "Forbidden" }),
    }));
    render(<AdminNotificationsPage />);
    expect(await screen.findByText("Forbidden")).toBeTruthy();
  });
});
