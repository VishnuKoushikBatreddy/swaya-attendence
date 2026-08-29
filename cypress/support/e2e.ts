// Cypress support file — loaded before every spec.
import "./commands";

/**
 * Warm the dev server before the first test touches it.
 *
 * `next dev` compiles routes ON DEMAND. The first request to the NextAuth
 * handler therefore has to build it, and on a cold server that can take longer
 * than a test is willing to wait — the login POST never completes, no session
 * cookie is set, and the spec fails. Re-running then passes, because the route
 * is now compiled. That is the whole of the intermittent failure people were
 * seeing: a build-time artefact of dev mode, not application behaviour.
 *
 * Requesting the routes up front (with a timeout long enough for a genuine cold
 * compile) makes the suite deterministic whether the server is warm or not.
 * Against a production build these return instantly and cost nothing.
 */
const WARM_TIMEOUT_MS = 180_000;

before(() => {
  // The credentials endpoint is the slow one — it is what the login POST hits.
  cy.request({ url: "/api/auth/csrf", timeout: WARM_TIMEOUT_MS });
  cy.request({ url: "/login", timeout: WARM_TIMEOUT_MS });
  // Middleware redirects these while signed out, which compiles the middleware
  // bundle without needing a session.
  cy.request({
    url: "/",
    timeout: WARM_TIMEOUT_MS,
    failOnStatusCode: false,
  });
});
