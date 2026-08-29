/**
 * Custom Cypress commands.
 */

declare global {
  namespace Cypress {
    interface Chainable {
      loginAs(role: "admin" | "manager" | "employee" | "super_admin", email?: string, password?: string): Chainable<void>;
      mockGeolocation(lat: number, lng: number, accuracy?: number, path?: string): Chainable<void>;
      setGeolocation(lat: number, lng: number, accuracy?: number, path?: string): Chainable<void>;
      logout(): Chainable<void>;
      clearDb(): Chainable<void>;
    }
  }
}

const CREDENTIALS: Record<string, { email: string; password: string }> = {
  admin: { email: "admin@demo.com", password: "password123" },
  manager: { email: "manager@demo.com", password: "password123" },
  employee: { email: "alice@demo.com", password: "password123" },
  super_admin: { email: "super@demo.com", password: "password123" },
};

type Coords = {
  latitude: number;
  longitude: number;
  accuracy: number;
  altitude: number | null;
  altitudeAccuracy: number | null;
  heading: number | null;
  speed: number | null;
  toJSON?: () => unknown;
};

function buildPosition(lat: number, lng: number, accuracy: number) {
  const coords: Coords = {
    latitude: lat,
    longitude: lng,
    accuracy,
    altitude: null,
    altitudeAccuracy: null,
    heading: null,
    speed: null,
    toJSON: () => ({}),
  };
  return {
    coords,
    timestamp: Date.now(),
  };
}

function stubGeolocation(win: Cypress.AUTWindow, lat: number, lng: number, accuracy: number) {
  cy.stub(win.navigator.geolocation, "getCurrentPosition").callsFake((success: PositionCallback) => {
    success(buildPosition(lat, lng, accuracy) as unknown as GeolocationPosition);
  });
  cy.stub(win.navigator.geolocation, "watchPosition").callsFake((success: PositionCallback) => {
    success(buildPosition(lat, lng, accuracy) as unknown as GeolocationPosition);
    return 1;
  });
}

const ROLE_HOME: Record<string, string> = {
  super_admin: "/super-admin",
  admin: "/admin",
  manager: "/manager",
  employee: "/employee",
};

/**
 * Poll /api/me until the session is live server-side.
 *
 * Explicit recursion rather than `cy.getCookie(...).should("exist")`: that does
 * NOT retry — it evaluates once, immediately after the click, long before the
 * sign-in round trip has finished, and fails with a bare "expected null to
 * exist". Asking the server whether it accepts the session is also a stronger
 * check than the cookie merely being present.
 */
function waitForSession(attempt = 0): Cypress.Chainable<void> {
  return cy
    .request({ url: "/api/me", failOnStatusCode: false, timeout: 60_000 })
    .then((res) => {
      if (res.status === 200) return;
      if (attempt >= 120) {
        throw new Error("Signed in but no session after 60s — check credentials/seed");
      }
      return cy.wait(500, { log: false }).then(() => waitForSession(attempt + 1));
    }) as Cypress.Chainable<void>;
}

Cypress.Commands.add("loginAs", (role, email, password) => {
  const cred = email && password ? { email, password } : CREDENTIALS[role];
  if (!cred) throw new Error("No credentials for role: " + role);
  return cy.visit("/login").then(() => {
    cy.get('input[type="email"]').clear().type(cred.email);
    cy.get('input[type="password"]').clear().type(cred.password);
    cy.get('button[type="submit"]').click();

    // Wait for the SESSION to be live, not for the URL to change.
    //
    // The page pushes to callbackUrl as soon as signIn() resolves. If the
    // session is not yet visible to the middleware, that request is bounced to
    // /login?callbackUrl=%2F — and it stays there, because nothing navigates
    // again. Retrying the URL assertion could never recover from it, which is
    // why this failed intermittently on a cold server (everything is slower, so
    // the race is easier to lose) and passed on every rerun.
    waitForSession();

    // Land on the role home explicitly rather than relying on the redirect that
    // just raced. In dev Next compiles routes on demand, so this first visit can
    // genuinely take a while.
    cy.visit(ROLE_HOME[role] ?? "/", { timeout: 60000 });
    cy.url({ timeout: 30000 }).should("not.include", "/login");
  });
});

Cypress.Commands.add("logout", () => {
  // NextAuth requires a server-issued CSRF token for signout. Hit /csrf first,
  // then POST to /api/auth/signout with that token. If signout is not strictly
  // required for a test, prefer clearing cookies directly to avoid 4xx noise.
  cy.clearCookies({ domain: null });
});

Cypress.Commands.add("clearDb", () => {
  cy.task("cleanup");
});

Cypress.Commands.add("mockGeolocation", (lat, lng, accuracy = 10, path = "/") => {
  return cy.visit(path, {
    onBeforeLoad(win) {
      stubGeolocation(win, lat, lng, accuracy);
    },
  });
});

Cypress.Commands.add("setGeolocation", (lat, lng, accuracy = 10, path = "/") => {
  return cy.visit(path, {
    onBeforeLoad(win) {
      stubGeolocation(win, lat, lng, accuracy);
    },
  });
});