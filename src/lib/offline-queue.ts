/**
 * Offline check-in / check-out queue (localStorage).
 *
 * When the network is down, a check-in/out is validated client-side (geofence)
 * and stored here with the REAL time it happened (`capturedAt`). When the device
 * is back online, replayQueue() POSTs each one to the server, which records it at
 * its captured time. Server-side 4xx rejections (e.g. outside geofence at that
 * time, or no active session) drop the item; network/5xx errors keep it to retry.
 */
export type QueuedAction = {
  id: string;
  type: "check-in" | "check-out";
  lat: number;
  lng: number;
  accuracy?: number;
  capturedAt: string; // ISO
  deviceId: string;
};

const KEY = "geo-attendance-offline-queue";

function read(): QueuedAction[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}

function write(items: QueuedAction[]) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* storage full / unavailable */
  }
}

export function getQueue(): QueuedAction[] {
  return read().sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
}

export function enqueueAction(a: Omit<QueuedAction, "id">): QueuedAction {
  const item: QueuedAction = {
    ...a,
    id: `${a.type}-${a.capturedAt}-${Math.random().toString(36).slice(2, 8)}`,
  };
  const items = read();
  items.push(item);
  write(items);
  return item;
}

function removeAction(id: string) {
  write(read().filter((i) => i.id !== id));
}

/** A queued action the server refused, with the reason it gave. */
export type RejectedAction = {
  type: QueuedAction["type"];
  capturedAt: string;
  reason: string;
};

export type ReplayResult = {
  synced: number;
  /**
   * Actions the server refused. These are dropped from the queue — retrying
   * cannot change the answer — but the employee has to be TOLD.
   *
   * The phone only checks the geofence before queueing, not the roster or the
   * shift window, so an offline check-in on an unscheduled day queues happily
   * and is then refused on sync. Dropping that silently left someone believing
   * they were checked in until an admin noticed days later.
   */
  rejected: RejectedAction[];
};

/** Replay queued actions oldest-first. */
export async function replayQueue(): Promise<ReplayResult> {
  const items = getQueue();
  let synced = 0;
  const rejected: RejectedAction[] = [];
  for (const item of items) {
    const url = item.type === "check-in" ? "/api/attendance/check-in" : "/api/attendance/check-out";
    const body =
      item.type === "check-in"
        ? {
            lat: item.lat,
            lng: item.lng,
            accuracy: item.accuracy,
            isMockLocation: false,
            deviceId: item.deviceId,
            capturedAt: item.capturedAt,
          }
        : { lat: item.lat, lng: item.lng, accuracy: item.accuracy, capturedAt: item.capturedAt };
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);
      if (res.ok && json?.ok) {
        removeAction(item.id);
        synced++;
      } else if (res.status >= 400 && res.status < 500) {
        // Server rejected it (outside geofence / no shift scheduled / out of
        // hours). Retrying cannot change that, so it is dropped — but the reason
        // is carried back so the employee finds out now rather than never.
        rejected.push({
          type: item.type,
          capturedAt: item.capturedAt,
          reason: json?.error || "It was refused by the server.",
        });
        removeAction(item.id);
      }
      // 5xx: leave it queued and try again next time.
    } catch {
      // Network still down — stop; we'll retry on the next "online" event.
      break;
    }
  }
  return { synced, rejected };
}
