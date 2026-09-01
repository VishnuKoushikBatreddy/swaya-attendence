/**
 * Admin dashboard: overview cards, sites, employees (with seed data),
 * shifts, schedules, audit, reports.
 */
describe("Admin dashboard", () => {
  before(() => {
    cy.task("seed");
  });

  beforeEach(() => {
    cy.loginAs("admin");
  });

  it("shows overview with stat cards", () => {
    cy.url().should("include", "/admin");
    cy.contains("Overview", { timeout: 10000 });
    cy.contains("Employees");
    cy.contains("Active sites");
  });

  it("shows sites page", () => {
    cy.visit("/admin/sites");
    cy.contains(/sites|Work sites/i, { timeout: 10000 });
  });

  it("shows employees page and lists seeded employees", () => {
    cy.visit("/admin/employees");
    cy.contains("Employees", { timeout: 10000 });
    cy.contains("Alice Employee", { timeout: 10000 });
    cy.contains("Bob Employee");
    cy.contains("admin@demo.com");
  });

  it("shows shifts page", () => {
    cy.visit("/admin/shifts");
    cy.contains(/Shifts|Day/i, { timeout: 10000 });
  });

  it("shows schedules page", () => {
    cy.visit("/admin/schedules");
    cy.contains(/Schedules/i, { timeout: 10000 });
  });

  it("shows audit page", () => {
    cy.visit("/admin/audit");
    cy.contains(/Audit/i, { timeout: 10000 });
  });

  it("shows reports page with date range", () => {
    cy.visit("/admin/reports");
    cy.contains("Reports", { timeout: 10000 });
    cy.contains("From");
    cy.contains("To");
    cy.contains("Download CSV");
  });
});
