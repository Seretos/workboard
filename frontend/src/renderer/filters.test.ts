import { describe, it, expect } from "vitest";
import { applyFilters, DEFAULT_FILTER_SETTINGS, FILTER_SETTINGS_STORAGE_KEY } from "./filters";
import type { TicketRow, Viewer } from "./types";

function makeTicket(overrides: Partial<TicketRow> & { id: string; project_id: string; project_path: string }): TicketRow {
  return {
    title: "Test ticket",
    status: "open",
    url: "https://example.com",
    labels: [],
    provider: "github",
    assignees: [],
    board_id: null,
    pull_request: null,
    worktree: null,
    ...overrides,
  };
}

const ALL_NULL_VIEWER: Viewer = { github: null, gitlab: null, azuredevops: null };

describe("filters — constants", () => {
  it("DEFAULT_FILTER_SETTINGS is assignedToMeOnly: false", () => {
    expect(DEFAULT_FILTER_SETTINGS).toEqual({ assignedToMeOnly: false });
  });

  it("FILTER_SETTINGS_STORAGE_KEY is the expected key", () => {
    expect(FILTER_SETTINGS_STORAGE_KEY).toBe("ticket-filter-settings");
  });
});

describe("applyFilters — filter off (passthrough)", () => {
  it("returns tickets unchanged and empty unresolvedProjects when viewer is all-null", () => {
    const tickets = [makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" })];
    const result = applyFilters(tickets, { assignedToMeOnly: false }, ALL_NULL_VIEWER);
    expect(result.tickets).toBe(tickets);
    expect(result.unresolvedProjects).toEqual([]);
  });

  it("returns tickets unchanged and empty unresolvedProjects when viewer is resolved", () => {
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha", assignees: ["someone-else"] }),
    ];
    const result = applyFilters(tickets, { assignedToMeOnly: false }, { github: "octocat", gitlab: null, azuredevops: null });
    expect(result.tickets).toBe(tickets);
    expect(result.unresolvedProjects).toEqual([]);
  });
});

describe("applyFilters — unresolved identity (filter on, viewer all-null)", () => {
  it("hides all tickets and records their project, deduped one-per-project (first path wins)", () => {
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha-first" }),
      makeTicket({ id: "2", project_id: "proj-a", project_path: "/repos/alpha-second" }),
      makeTicket({ id: "3", project_id: "proj-b", project_path: "/repos/beta" }),
    ];
    const result = applyFilters(tickets, { assignedToMeOnly: true }, ALL_NULL_VIEWER);
    expect(result.tickets).toEqual([]);
    expect(result.unresolvedProjects).toEqual([
      { project_id: "proj-a", project_path: "/repos/alpha-first" },
      { project_id: "proj-b", project_path: "/repos/beta" },
    ]);
  });

  it("empty input returns empty tickets and empty unresolvedProjects", () => {
    const result = applyFilters([], { assignedToMeOnly: true }, ALL_NULL_VIEWER);
    expect(result.tickets).toEqual([]);
    expect(result.unresolvedProjects).toEqual([]);
  });
});

describe("applyFilters — resolved identity (filter on)", () => {
  const viewer: Viewer = { github: "octocat", gitlab: null, azuredevops: null };

  it("keeps a ticket whose assignees include the resolved identity", () => {
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha", assignees: ["octocat"] }),
    ];
    const result = applyFilters(tickets, { assignedToMeOnly: true }, viewer);
    expect(result.tickets).toEqual(tickets);
    expect(result.unresolvedProjects).toEqual([]);
  });

  it("drops a ticket whose assignees do not include the resolved identity", () => {
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha", assignees: ["someone"] }),
    ];
    const result = applyFilters(tickets, { assignedToMeOnly: true }, viewer);
    expect(result.tickets).toEqual([]);
    expect(result.unresolvedProjects).toEqual([]);
  });

  it("drops a ticket with an empty assignees array", () => {
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha", assignees: [] }),
    ];
    const result = applyFilters(tickets, { assignedToMeOnly: true }, viewer);
    expect(result.tickets).toEqual([]);
  });

  it("drops a ticket with missing assignees field without throwing", () => {
    const ticket = makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" });
    delete (ticket as Partial<TicketRow>).assignees;
    expect(() => {
      const result = applyFilters([ticket], { assignedToMeOnly: true }, viewer);
      expect(result.tickets).toEqual([]);
    }).not.toThrow();
  });

  it("keeps a ticket with multiple assignees including the resolved identity", () => {
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha", assignees: ["someone", "octocat", "other"] }),
    ];
    const result = applyFilters(tickets, { assignedToMeOnly: true }, viewer);
    expect(result.tickets).toEqual(tickets);
  });
});

describe("applyFilters — mixed resolved/unresolved providers", () => {
  it("keeps github-matched ticket and hides+flags the gitlab-unresolved ticket in the same call", () => {
    const viewer: Viewer = { github: "octocat", gitlab: null, azuredevops: null };
    const githubTicket = makeTicket({
      id: "1",
      project_id: "proj-a",
      project_path: "/repos/alpha",
      provider: "github",
      assignees: ["octocat"],
    });
    const gitlabTicket = makeTicket({
      id: "2",
      project_id: "proj-b",
      project_path: "/repos/beta",
      provider: "gitlab",
      assignees: ["someone"],
    });

    const result = applyFilters([githubTicket, gitlabTicket], { assignedToMeOnly: true }, viewer);

    expect(result.tickets).toEqual([githubTicket]);
    expect(result.unresolvedProjects).toEqual([{ project_id: "proj-b", project_path: "/repos/beta" }]);
  });
});
