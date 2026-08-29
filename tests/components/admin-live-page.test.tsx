// @vitest-environment jsdom
/**
 * Rendering tests for the admin Live status page.
 *
 * The endpoint has API tests and the logic is pure, but the CLIENT WIRING had no
 * coverage: that the fetch result reaches the DOM, that polling refreshes it,
 * that the search filters, and that checked-in people sort to the top. Those are
 * only observable by rendering.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AdminLivePage from "@/app/(dashboard)/admin/live/page";

const HOUR = 3_600_000;

function payload(over: Partial<any> = {}) {
  const now = Date.now();
  return {
    ok: true,
    data: {
      workDate: "2026-08-17",
      summary: { total: 2, checkedIn: 1, outsideGeofence: 0, flagged: 0 },
      employees: [
        {
          id: "1",
          fullName: "Zara Absent",
          email: "zara@x.com",
          employeeCode: "E9",
          department: "Ops",
          checkedIn: false,
          checkedInAt: null,
          siteName: null,
          lastSeenAt: null,
          lastSeenMinutesAgo: null,
          isInsideGeofence: null,
          distanceFromSiteMeters: null,
          dayStatus: null,
          totalWorkSeconds: 0,
          isFlagged: false,
          firstCheckInAt: null,
          lastCheckOutAt: null,
        },
        {
          id: "2",
          fullName: "Alice Working",
          email: "alice@x.com",
          employeeCode: "E1",
          department: "Eng",
          checkedIn: true,
          checkedInAt: new Date(now - 2 * HOUR).toISOString(),
          siteName: "Main Office",
          lastSeenAt: new Date(now - 60_000).toISOString(),
          lastSeenMinutesAgo: 1,
          isInsideGeofence: true,
          distanceFromSiteMeters: 12,
          dayStatus: "present",
          totalWorkSeconds: 7200,
          isFlagged: false,
          firstCheckInAt: new Date(now - 2 * HOUR).toISOString(),
          lastCheckOutAt: null,
        },
      ],
      ...over,
    },
  };
}

const mockFetch = (body: any) =>
  vi.fn(async () => ({ ok: true, json: async () => body })) as any;

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AdminLivePage rendering", () => {
  it("renders employees returned by the API", async () => {
    global.fetch = mockFetch(payload());
    render(<AdminLivePage />);

    expect(await screen.findByText("Alice Working")).toBeTruthy();
    expect(screen.getByText("Zara Absent")).toBeTruthy();
  });

  it("shows the summary counters from the server", async () => {
    global.fetch = mockFetch(payload());
    render(<AdminLivePage />);

    await screen.findByText("Alice Working");
    const checkedIn = screen.getByText("Checked in now").closest("div")!;
    expect(within(checkedIn).getByText("1")).toBeTruthy();
  });

  it("sorts checked-in employees above the rest", async () => {
    // Alice is second in the payload but checked in, so must render first.
    global.fetch = mockFetch(payload());
    const { container } = render(<AdminLivePage />);

    await screen.findByText("Alice Working");
    const names = Array.from(container.querySelectorAll("li")).map(
      (li) => li.textContent || ""
    );
    expect(names[0]).toContain("Alice Working");
    expect(names[1]).toContain("Zara Absent");
  });

  it("shows the site and last-seen age for someone on shift", async () => {
    global.fetch = mockFetch(payload());
    render(<AdminLivePage />);

    await screen.findByText("Alice Working");
    expect(screen.getByText(/Main Office/)).toBeTruthy();
    expect(screen.getByText(/last seen 1m ago/)).toBeTruthy();
  });

  it("badges someone who is checked in but away from the site", async () => {
    const p = payload();
    p.data.employees[1].isInsideGeofence = false;
    p.data.employees[1].distanceFromSiteMeters = 312;
    p.data.summary.outsideGeofence = 1;
    global.fetch = mockFetch(p);
    render(<AdminLivePage />);

    expect(await screen.findByText("312m away")).toBeTruthy();
  });

  it("filters by the search box", async () => {
    global.fetch = mockFetch(payload());
    const user = userEvent.setup();
    render(<AdminLivePage />);

    await screen.findByText("Alice Working");
    await user.type(screen.getByLabelText("Search employees"), "Zara");

    await waitFor(() => {
      expect(screen.queryByText("Alice Working")).toBeNull();
    });
    expect(screen.getByText("Zara Absent")).toBeTruthy();
  });

  it("says so when nothing matches the search", async () => {
    global.fetch = mockFetch(payload());
    const user = userEvent.setup();
    render(<AdminLivePage />);

    await screen.findByText("Alice Working");
    await user.type(screen.getByLabelText("Search employees"), "nobody-here");

    expect(await screen.findByText("No one matches that search.")).toBeTruthy();
  });

  it("keeps the last good view when a refresh fails", async () => {
    let call = 0;
    global.fetch = vi.fn(async () => {
      call++;
      if (call === 1) return { ok: true, json: async () => payload() } as any;
      throw new Error("network down");
    }) as any;

    render(<AdminLivePage />);
    await screen.findByText("Alice Working");

    // Manual refresh fails; the table must not blank out.
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(call).toBeGreaterThan(1));
    expect(screen.getByText("Alice Working")).toBeTruthy();
  });

  it("renders an empty state when the company has no employees", async () => {
    global.fetch = mockFetch(
      payload({
        summary: { total: 0, checkedIn: 0, outsideGeofence: 0, flagged: 0 },
        employees: [],
      })
    );
    render(<AdminLivePage />);
    expect(await screen.findByText("No employees yet.")).toBeTruthy();
  });
});
