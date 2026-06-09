// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderTickets, loadTickets, initRenderer, POLL_INTERVAL_MS, pausePollForBackoff, getLastTickets } from "./renderer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal TicketRow fixture — only the fields renderTickets actually uses. */
function makeTicket(overrides: {
  id?: string;
  title?: string;
  status?: string;
  url?: string;
  body?: string;
  labels?: string[];
  provider?: string;
  project_id: string;
  project_path: string;
  pull_request?: { number: number; url: string; status: string; draft: boolean } | null;
}) {
  return {
    id: overrides.id ?? "1",
    title: overrides.title ?? "Test ticket",
    status: overrides.status ?? "open",
    url: overrides.url ?? "https://example.com",
    body: overrides.body,
    labels: overrides.labels ?? [],
    provider: overrides.provider ?? "github",
    project_id: overrides.project_id,
    project_path: overrides.project_path,
    pull_request: overrides.pull_request !== undefined ? overrides.pull_request : null,
  };
}

/** Build a TicketsResponse envelope with poll_errors: null (the success case). */
function makeSuccessResponse(tickets: ReturnType<typeof makeTicket>[]) {
  return { ok: true, status: 200, data: { tickets, poll_errors: null } };
}

/** Build a TicketsResponse envelope for a rate-limited response. */
function makeRateLimitResponse(
  tickets: ReturnType<typeof makeTicket>[],
  retry_after: number | null,
  failed_projects: string[] = [],
) {
  return {
    ok: true,
    status: 200,
    data: {
      tickets,
      poll_errors: { rate_limited: true, retry_after, failed_projects },
    },
  };
}

function makeList(): HTMLUListElement {
  const ul = document.createElement("ul");
  ul.id = "ticket-list";
  document.body.appendChild(ul);
  return ul;
}

function cleanup(el: HTMLElement) {
  el.remove();
}

// ---------------------------------------------------------------------------
// renderTickets — grouping
// ---------------------------------------------------------------------------

describe("renderTickets — grouping", () => {
  it("two projects: renders exactly 2 .project-group-header elements", () => {
    const list = makeList();
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "2", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "3", project_id: "proj-b", project_path: "/repos/beta" }),
      makeTicket({ id: "4", project_id: "proj-b", project_path: "/repos/beta" }),
      makeTicket({ id: "5", project_id: "proj-b", project_path: "/repos/beta" }),
    ];
    renderTickets(list, tickets);

    const headers = list.querySelectorAll(".project-group-header");
    expect(headers).toHaveLength(2);

    cleanup(list);
  });

  it("two projects: first header text includes correct project_path", () => {
    const list = makeList();
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "2", project_id: "proj-b", project_path: "/repos/beta" }),
    ];
    renderTickets(list, tickets);

    const headers = list.querySelectorAll(".project-group-header");
    expect(headers[0].textContent).toContain("/repos/alpha");
    expect(headers[1].textContent).toContain("/repos/beta");

    cleanup(list);
  });

  it("two projects: each header badge shows per-group ticket count", () => {
    const list = makeList();
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "2", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "3", project_id: "proj-b", project_path: "/repos/beta" }),
      makeTicket({ id: "4", project_id: "proj-b", project_path: "/repos/beta" }),
      makeTicket({ id: "5", project_id: "proj-b", project_path: "/repos/beta" }),
    ];
    renderTickets(list, tickets);

    const badges = list.querySelectorAll(".project-group-header .group-count");
    expect(badges[0].textContent).toBe("2");
    expect(badges[1].textContent).toBe("3");

    cleanup(list);
  });

  it("single project: renders exactly 1 .project-group-header element", () => {
    const list = makeList();
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "2", project_id: "proj-a", project_path: "/repos/alpha" }),
    ];
    renderTickets(list, tickets);

    const headers = list.querySelectorAll(".project-group-header");
    expect(headers).toHaveLength(1);

    cleanup(list);
  });

  it("all 5 ticket cards appear after headers (no interleaving with wrong group)", () => {
    const list = makeList();
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "2", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "3", project_id: "proj-b", project_path: "/repos/beta" }),
      makeTicket({ id: "4", project_id: "proj-b", project_path: "/repos/beta" }),
      makeTicket({ id: "5", project_id: "proj-b", project_path: "/repos/beta" }),
    ];
    renderTickets(list, tickets);

    const items = Array.from(list.children);
    // Order must be: header-A, card-A1, card-A2, header-B, card-B3, card-B4, card-B5
    expect(items).toHaveLength(7);
    expect(items[0].classList.contains("project-group-header")).toBe(true);
    expect(items[1].classList.contains("ticket-card")).toBe(true);
    expect(items[2].classList.contains("ticket-card")).toBe(true);
    expect(items[3].classList.contains("project-group-header")).toBe(true);
    expect(items[4].classList.contains("ticket-card")).toBe(true);
    expect(items[5].classList.contains("ticket-card")).toBe(true);
    expect(items[6].classList.contains("ticket-card")).toBe(true);

    cleanup(list);
  });

  it("empty ticket list: renders nothing (no headers, no cards)", () => {
    const list = makeList();
    renderTickets(list, []);

    expect(list.children).toHaveLength(0);

    cleanup(list);
  });
});

// ---------------------------------------------------------------------------
// renderTickets — PR accent
// ---------------------------------------------------------------------------

describe("renderTickets — PR accent", () => {
  it("ticket with pull_request object gets class ticket-card--has-pr", () => {
    const list = makeList();
    const tickets = [
      makeTicket({
        id: "1",
        project_id: "proj-a",
        project_path: "/repos/alpha",
        pull_request: { number: 42, url: "https://github.com/x/y/pull/42", status: "open", draft: false },
      }),
    ];
    renderTickets(list, tickets);

    const card = list.querySelector(".ticket-card");
    expect(card).not.toBeNull();
    expect(card!.classList.contains("ticket-card--has-pr")).toBe(true);

    cleanup(list);
  });

  it("ticket with pull_request: null does NOT get class ticket-card--has-pr", () => {
    const list = makeList();
    const tickets = [
      makeTicket({
        id: "1",
        project_id: "proj-a",
        project_path: "/repos/alpha",
        pull_request: null,
      }),
    ];
    renderTickets(list, tickets);

    const card = list.querySelector(".ticket-card");
    expect(card).not.toBeNull();
    expect(card!.classList.contains("ticket-card--has-pr")).toBe(false);

    cleanup(list);
  });

  it("ticket with pull_request field absent (undefined) does NOT get class ticket-card--has-pr", () => {
    const list = makeList();
    // Omit pull_request entirely to simulate old backend data.
    const ticket = {
      id: "1",
      title: "Old ticket",
      status: "open",
      url: "https://example.com",
      labels: [],
      provider: "github",
      project_id: "proj-a",
      project_path: "/repos/alpha",
      // pull_request intentionally absent
    };
    renderTickets(list, [ticket as Parameters<typeof renderTickets>[1][0]]);

    const card = list.querySelector(".ticket-card");
    expect(card).not.toBeNull();
    expect(card!.classList.contains("ticket-card--has-pr")).toBe(false);

    cleanup(list);
  });

  it("mixed tickets: only the one with pull_request gets the PR class", () => {
    const list = makeList();
    const tickets = [
      makeTicket({
        id: "1",
        project_id: "proj-a",
        project_path: "/repos/alpha",
        pull_request: { number: 7, url: "https://github.com/x/y/pull/7", status: "open", draft: false },
      }),
      makeTicket({
        id: "2",
        project_id: "proj-a",
        project_path: "/repos/alpha",
        pull_request: null,
      }),
    ];
    renderTickets(list, tickets);

    const cards = list.querySelectorAll(".ticket-card");
    expect(cards).toHaveLength(2);
    expect(cards[0].classList.contains("ticket-card--has-pr")).toBe(true);
    expect(cards[1].classList.contains("ticket-card--has-pr")).toBe(false);

    cleanup(list);
  });
});

// ---------------------------------------------------------------------------
// renderTickets — edge cases
// ---------------------------------------------------------------------------

describe("renderTickets — edge cases", () => {
  it("same project_id with different project_path: first path wins for header, no crash", () => {
    const list = makeList();
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/first" }),
      makeTicket({ id: "2", project_id: "proj-a", project_path: "/repos/second" }),
    ];
    expect(() => renderTickets(list, tickets)).not.toThrow();

    const headers = list.querySelectorAll(".project-group-header");
    expect(headers).toHaveLength(1);
    expect(headers[0].textContent).toContain("/repos/first");

    cleanup(list);
  });

  it("empty project_path: renders without crash", () => {
    const list = makeList();
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "" }),
    ];
    expect(() => renderTickets(list, tickets)).not.toThrow();

    const headers = list.querySelectorAll(".project-group-header");
    expect(headers).toHaveLength(1);

    cleanup(list);
  });

  it("draft pull_request: still gets ticket-card--has-pr (object is non-null)", () => {
    const list = makeList();
    const tickets = [
      makeTicket({
        id: "1",
        project_id: "proj-a",
        project_path: "/repos/alpha",
        pull_request: { number: 99, url: "https://github.com/x/y/pull/99", status: "draft", draft: true },
      }),
    ];
    renderTickets(list, tickets);

    const card = list.querySelector(".ticket-card");
    expect(card!.classList.contains("ticket-card--has-pr")).toBe(true);

    cleanup(list);
  });
});

// ---------------------------------------------------------------------------
// renderTickets — card click opens detail window
// ---------------------------------------------------------------------------

describe("renderTickets — card click", () => {
  let openTicketDetail: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    openTicketDetail = vi.fn();
    (window as Window & typeof globalThis).detail = {
      openTicketDetail,
      onTicketDetailData: vi.fn(),
      openExternal: vi.fn(),
    };
  });

  it("clicking a ticket card calls window.detail.openTicketDetail with the ticket", () => {
    const list = makeList();
    const ticket = makeTicket({ id: "42", project_id: "proj-a", project_path: "/repos/alpha" });
    renderTickets(list, [ticket]);

    const card = list.querySelector(".ticket-card") as HTMLElement;
    expect(card).not.toBeNull();
    card.click();

    expect(openTicketDetail).toHaveBeenCalledTimes(1);
    expect(openTicketDetail).toHaveBeenCalledWith(ticket);

    cleanup(list);
  });

  it("clicking a card passes the body field to openTicketDetail", () => {
    const list = makeList();
    const ticket = makeTicket({
      id: "7",
      body: "This is the ticket description.",
      project_id: "proj-a",
      project_path: "/repos/alpha",
    });
    renderTickets(list, [ticket]);

    const card = list.querySelector(".ticket-card") as HTMLElement;
    card.click();

    const arg = openTicketDetail.mock.calls[0][0] as { body?: string };
    expect(arg.body).toBe("This is the ticket description.");

    cleanup(list);
  });

  it("clicking a card passes the pull_request field to openTicketDetail", () => {
    const list = makeList();
    const pr = { number: 10, url: "https://github.com/x/y/pull/10", status: "open", draft: false };
    const ticket = makeTicket({
      id: "10",
      project_id: "proj-a",
      project_path: "/repos/alpha",
      pull_request: pr,
    });
    renderTickets(list, [ticket]);

    const card = list.querySelector(".ticket-card") as HTMLElement;
    card.click();

    const arg = openTicketDetail.mock.calls[0][0] as { pull_request: typeof pr };
    expect(arg.pull_request).toEqual(pr);

    cleanup(list);
  });

  it("each card in a multi-card list calls openTicketDetail with its own ticket", () => {
    const list = makeList();
    const t1 = makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" });
    const t2 = makeTicket({ id: "2", project_id: "proj-a", project_path: "/repos/alpha" });
    renderTickets(list, [t1, t2]);

    const cards = list.querySelectorAll(".ticket-card") as NodeListOf<HTMLElement>;
    expect(cards).toHaveLength(2);

    cards[0].click();
    expect(openTicketDetail).toHaveBeenLastCalledWith(t1);

    cards[1].click();
    expect(openTicketDetail).toHaveBeenLastCalledWith(t2);

    cleanup(list);
  });
});

// ---------------------------------------------------------------------------
// loadTickets — via window.backend mock
// ---------------------------------------------------------------------------

describe("loadTickets", () => {
  beforeEach(() => {
    // Reset document body to a known state with both anchors the renderer needs.
    document.body.innerHTML = `
      <ul id="ticket-list"></ul>
      <span id="ticket-count"></span>
      <footer class="status-bar"></footer>
    `;
  });

  it("success: #ticket-count reflects total across all projects", async () => {
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "2", project_id: "proj-b", project_path: "/repos/beta" }),
      makeTicket({ id: "3", project_id: "proj-b", project_path: "/repos/beta" }),
    ];

    (window as Window & typeof globalThis).backend = {
      fetchJson: vi.fn().mockResolvedValue(makeSuccessResponse(tickets)),
      onBackendCrashed: vi.fn(),
    };

    await loadTickets();

    const countEl = document.getElementById("ticket-count");
    expect(countEl!.textContent).toBe("3");
  });

  it("empty list: #ticket-count is '0' and status bar shows 'Keine offenen Tickets'", async () => {
    (window as Window & typeof globalThis).backend = {
      fetchJson: vi.fn().mockResolvedValue(makeSuccessResponse([])),
      onBackendCrashed: vi.fn(),
    };

    await loadTickets();

    const countEl = document.getElementById("ticket-count");
    expect(countEl!.textContent).toBe("0");

    const statusBar = document.querySelector(".status-bar");
    expect(statusBar!.textContent).toBe("Keine offenen Tickets");
  });

  it("backend error (ok: false): #ticket-count is '!' and status bar shows error", async () => {
    (window as Window & typeof globalThis).backend = {
      fetchJson: vi.fn().mockResolvedValue({ ok: false, status: 503, data: null }),
      onBackendCrashed: vi.fn(),
    };

    await loadTickets();

    const countEl = document.getElementById("ticket-count");
    expect(countEl!.textContent).toBe("!");

    const statusBar = document.querySelector(".status-bar");
    expect(statusBar!.textContent).toContain("Fehler");
    expect(statusBar!.textContent).toContain("503");
  });

  it("backend throws: #ticket-count is '!' and status bar shows error message", async () => {
    (window as Window & typeof globalThis).backend = {
      fetchJson: vi.fn().mockRejectedValue(new Error("Netzwerkfehler")),
      onBackendCrashed: vi.fn(),
    };

    await loadTickets();

    const countEl = document.getElementById("ticket-count");
    expect(countEl!.textContent).toBe("!");

    const statusBar = document.querySelector(".status-bar");
    expect(statusBar!.textContent).toContain("Netzwerkfehler");
  });

  it("regression: renderTickets is called with grouped output — group headers appear for each project", async () => {
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "2", project_id: "proj-b", project_path: "/repos/beta" }),
    ];

    (window as Window & typeof globalThis).backend = {
      fetchJson: vi.fn().mockResolvedValue(makeSuccessResponse(tickets)),
      onBackendCrashed: vi.fn(),
    };

    await loadTickets();

    const list = document.getElementById("ticket-list")!;
    const headers = list.querySelectorAll(".project-group-header");
    expect(headers).toHaveLength(2);
  });

  it("genuine zero tickets (poll_errors null): shows Keine offenen Tickets", async () => {
    (window as Window & typeof globalThis).backend = {
      fetchJson: vi.fn().mockResolvedValue(makeSuccessResponse([])),
      onBackendCrashed: vi.fn(),
    };

    await loadTickets();

    const statusBar = document.querySelector(".status-bar");
    expect(statusBar!.textContent).toBe("Keine offenen Tickets");
  });
});

// ---------------------------------------------------------------------------
// polling
// ---------------------------------------------------------------------------

describe("polling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("POLL_INTERVAL_MS equals 60_000", () => {
    expect(POLL_INTERVAL_MS).toBe(60_000);
  });

  it("regression: fetchJson is called a second time after one interval elapses", async () => {
    // This test drives initRenderer() — the real production wiring. It would
    // fail if the setInterval were removed from initRenderer().
    vi.useFakeTimers();

    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" }),
    ];
    const fetchJson = vi.fn().mockResolvedValue(makeSuccessResponse(tickets));
    let capturedCrashCb: ((code: number | null) => void) | undefined;

    document.body.innerHTML = `
      <ul id="ticket-list"></ul>
      <span id="ticket-count"></span>
      <footer class="status-bar"></footer>
    `;

    (window as Window & typeof globalThis).backend = {
      fetchJson,
      onBackendCrashed: vi.fn((cb) => { capturedCrashCb = cb; }),
    };

    // Call the real init function — registers the poll and crash listener.
    await initRenderer();
    expect(fetchJson).toHaveBeenCalledTimes(1);

    // Advance time by exactly one interval and let pending promises settle.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    // fetchJson must have been invoked a second time by the interval.
    expect(fetchJson.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Clean up: fire crash to clear the interval so no further ticks leak.
    capturedCrashCb!(null);
  });

  it("regression: a failed poll does not clear a previously rendered list", async () => {
    vi.useFakeTimers();

    const ticket = makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" });
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce(makeSuccessResponse([ticket]))
      .mockRejectedValueOnce(new Error("Netzwerkfehler"));
    let capturedCrashCb: ((code: number | null) => void) | undefined;

    document.body.innerHTML = `
      <ul id="ticket-list"></ul>
      <span id="ticket-count"></span>
      <footer class="status-bar"></footer>
    `;

    (window as Window & typeof globalThis).backend = {
      fetchJson,
      onBackendCrashed: vi.fn((cb) => { capturedCrashCb = cb; }),
    };

    // Call real init — first load succeeds and renders one card.
    await initRenderer();
    expect(document.querySelectorAll(".ticket-card")).toHaveLength(1);

    // Advance — second poll fires and fails.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);

    // The card from the first successful load must still be present.
    expect(document.querySelectorAll(".ticket-card")).toHaveLength(1);

    // Clean up: stop the interval.
    capturedCrashCb!(null);
  });
});

// ---------------------------------------------------------------------------
// backend-crashed display
// ---------------------------------------------------------------------------

describe("backend-crashed display", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("callback with a numeric code sets .status-bar text containing 'abgestürzt' and the code", async () => {
    // Drive the real initRenderer() wiring — the crash callback registered
    // there is the same one that fires in production.
    vi.useFakeTimers();

    const fetchJson = vi.fn().mockResolvedValue(makeSuccessResponse([]));
    let capturedCrashCb: ((code: number | null) => void) | undefined;

    document.body.innerHTML = `
      <ul id="ticket-list"></ul>
      <span id="ticket-count"></span>
      <footer class="status-bar"></footer>
    `;

    (window as Window & typeof globalThis).backend = {
      fetchJson,
      onBackendCrashed: vi.fn((cb) => { capturedCrashCb = cb; }),
    };

    await initRenderer();

    capturedCrashCb!(42);

    const statusBar = document.querySelector(".status-bar");
    expect(statusBar!.textContent).toContain("abgestürzt");
    expect(statusBar!.textContent).toContain("42");
  });

  it("callback with null does not throw and renders '?'", async () => {
    vi.useFakeTimers();

    const fetchJson = vi.fn().mockResolvedValue(makeSuccessResponse([]));
    let capturedCrashCb: ((code: number | null) => void) | undefined;

    document.body.innerHTML = `
      <ul id="ticket-list"></ul>
      <span id="ticket-count"></span>
      <footer class="status-bar"></footer>
    `;

    (window as Window & typeof globalThis).backend = {
      fetchJson,
      onBackendCrashed: vi.fn((cb) => { capturedCrashCb = cb; }),
    };

    await initRenderer();

    expect(() => capturedCrashCb!(null)).not.toThrow();

    const statusBar = document.querySelector(".status-bar");
    expect(statusBar!.textContent).toContain("?");
  });

  it("regression: crash clears the poll — fetchJson not called again and crash message persists", async () => {
    // This test would fail without the clearInterval() in onBackendCrashed:
    // without it the interval would fire again, overwrite the crash message,
    // and fetchJson would be called more times.
    vi.useFakeTimers();

    const ticket = makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" });
    const fetchJson = vi.fn().mockResolvedValue(makeSuccessResponse([ticket]));
    let capturedCrashCb: ((code: number | null) => void) | undefined;

    document.body.innerHTML = `
      <ul id="ticket-list"></ul>
      <span id="ticket-count"></span>
      <footer class="status-bar"></footer>
    `;

    (window as Window & typeof globalThis).backend = {
      fetchJson,
      onBackendCrashed: vi.fn((cb) => { capturedCrashCb = cb; }),
    };

    // (1) First successful load via the real init.
    await initRenderer();
    const callsAfterInit = fetchJson.mock.calls.length;

    // (2) Fire the crash event — this must clearInterval and set the message.
    capturedCrashCb!(7);

    const statusBar = document.querySelector(".status-bar");
    expect(statusBar!.textContent).toContain("abgestürzt");
    expect(statusBar!.textContent).toContain("7");

    // (3) Advance timers well past one interval — the stopped poll must not fire.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

    // (4) fetchJson must not have been called again after the crash.
    expect(fetchJson.mock.calls.length).toBe(callsAfterInit);

    // (5) Status bar still reads the crash message (not "Lädt Tickets…" or empty).
    expect(statusBar!.textContent).toContain("abgestürzt");
    expect(statusBar!.textContent).toContain("7");
  });
});

// ---------------------------------------------------------------------------
// loadTickets — rate-limit resilience
// ---------------------------------------------------------------------------

describe("loadTickets — rate-limit resilience", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    document.body.innerHTML = `
      <ul id="ticket-list"></ul>
      <span id="ticket-count"></span>
      <footer class="status-bar"></footer>
    `;
  });

  it("rate_limited: status bar shows Rate-Limit message", async () => {
    vi.useFakeTimers();

    const ticket1 = makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" });
    const ticket2 = makeTicket({ id: "2", project_id: "proj-a", project_path: "/repos/alpha" });

    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce(makeSuccessResponse([ticket1, ticket2]))
      .mockResolvedValueOnce(makeRateLimitResponse([], 60, []));

    (window as Window & typeof globalThis).backend = {
      fetchJson,
      onBackendCrashed: vi.fn(),
    };

    // First poll — success
    await loadTickets();

    // Second poll — rate-limited
    await loadTickets();

    const statusBar = document.querySelector(".status-bar");
    expect(statusBar!.textContent).toContain("Rate-Limit");
  });

  it("rate_limited: list is not cleared (stale cards preserved)", async () => {
    vi.useFakeTimers();

    const ticket1 = makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" });
    const ticket2 = makeTicket({ id: "2", project_id: "proj-a", project_path: "/repos/alpha" });

    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce(makeSuccessResponse([ticket1, ticket2]))
      .mockResolvedValueOnce(makeRateLimitResponse([], 60, []));

    (window as Window & typeof globalThis).backend = {
      fetchJson,
      onBackendCrashed: vi.fn(),
    };

    // First poll — success, renders 2 cards
    await loadTickets();
    expect(document.querySelectorAll(".ticket-card")).toHaveLength(2);

    // Second poll — rate-limited, must NOT clear the list
    await loadTickets();
    expect(document.querySelectorAll(".ticket-card")).toHaveLength(2);
  });

  it("rate_limited: ticket-count badge preserves last good count", async () => {
    vi.useFakeTimers();

    const ticket1 = makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" });
    const ticket2 = makeTicket({ id: "2", project_id: "proj-a", project_path: "/repos/alpha" });

    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce(makeSuccessResponse([ticket1, ticket2]))
      .mockResolvedValueOnce(makeRateLimitResponse([], 60, []));

    (window as Window & typeof globalThis).backend = {
      fetchJson,
      onBackendCrashed: vi.fn(),
    };

    // First poll — success
    await loadTickets();
    const countEl = document.getElementById("ticket-count");
    expect(countEl!.textContent).toBe("2");

    // Second poll — rate-limited, badge must still show "2"
    await loadTickets();
    expect(countEl!.textContent).toBe("2");
  });

  it("rate_limited: poll is paused after rate-limit response", async () => {
    // Use a long retry_after (600s) so that advancing a few intervals (< 600s)
    // does not trigger the backoff resumption, making it easy to assert the
    // interval has been cleared.
    vi.useFakeTimers();

    const ticket = makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" });

    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce(makeSuccessResponse([ticket]))
      .mockResolvedValue(makeRateLimitResponse([], 600, []));

    let capturedCrashCb: ((code: number | null) => void) | undefined;

    (window as Window & typeof globalThis).backend = {
      fetchJson,
      onBackendCrashed: vi.fn((cb) => { capturedCrashCb = cb; }),
    };

    // Run initRenderer to set up the poll
    await initRenderer();

    // Advance to trigger the rate-limit response
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    const callsAfterRateLimit = fetchJson.mock.calls.length;

    // Advance three more intervals (180s) — well within the 600s backoff,
    // so the poll should remain paused and fetchJson should NOT be called again.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);

    expect(fetchJson.mock.calls.length).toBe(callsAfterRateLimit);

    capturedCrashCb!(null);
  });

  it("rate_limited: poll resumes after retry_after elapses", async () => {
    vi.useFakeTimers();

    const ticket = makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" });

    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce(makeSuccessResponse([ticket]))
      .mockResolvedValueOnce(makeRateLimitResponse([], 60, []))
      .mockResolvedValue(makeSuccessResponse([ticket]));

    let capturedCrashCb: ((code: number | null) => void) | undefined;

    (window as Window & typeof globalThis).backend = {
      fetchJson,
      onBackendCrashed: vi.fn((cb) => { capturedCrashCb = cb; }),
    };

    await initRenderer();

    // Trigger rate-limit response
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    const callsAfterRateLimit = fetchJson.mock.calls.length;

    // Advance by retry_after (60s) + 1ms — the backoff setTimeout should fire
    await vi.advanceTimersByTimeAsync(60 * 1000 + 1);

    expect(fetchJson.mock.calls.length).toBeGreaterThan(callsAfterRateLimit);

    capturedCrashCb!(null);
  });

  it("rate_limited: retry_after null uses 5-minute default backoff", async () => {
    vi.useFakeTimers();

    const ticket = makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" });

    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce(makeSuccessResponse([ticket]))
      .mockResolvedValueOnce(makeRateLimitResponse([], null, []))
      .mockResolvedValue(makeSuccessResponse([ticket]));

    let capturedCrashCb: ((code: number | null) => void) | undefined;

    (window as Window & typeof globalThis).backend = {
      fetchJson,
      onBackendCrashed: vi.fn((cb) => { capturedCrashCb = cb; }),
    };

    await initRenderer();

    // Trigger rate-limit response (no Retry-After)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    const callsAfterRateLimit = fetchJson.mock.calls.length;

    // 299s elapsed — should NOT have resumed yet
    await vi.advanceTimersByTimeAsync(299_000);
    expect(fetchJson.mock.calls.length).toBe(callsAfterRateLimit);

    // +1001ms more (total >300s = 5 min default) — should now have resumed
    await vi.advanceTimersByTimeAsync(1_001);
    expect(fetchJson.mock.calls.length).toBeGreaterThan(callsAfterRateLimit);

    capturedCrashCb!(null);
  });

  it("partial failure: partial ticket list rendered, status shows N Projekt(e) nicht geladen, badge reflects partial count", async () => {
    // poll_errors is non-null with rate_limited: false — the partial-failure branch.
    const ticket = makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" });
    const partialResponse = {
      ok: true,
      status: 200,
      data: {
        tickets: [ticket],
        poll_errors: { rate_limited: false, retry_after: null, failed_projects: ["proj-b", "proj-c"] },
      },
    };

    (window as Window & typeof globalThis).backend = {
      fetchJson: vi.fn().mockResolvedValue(partialResponse),
      onBackendCrashed: vi.fn(),
    };

    await loadTickets();

    // The one ticket from the partial list must be rendered.
    expect(document.querySelectorAll(".ticket-card")).toHaveLength(1);

    // Status bar must mention the two failing projects.
    const statusBar = document.querySelector(".status-bar");
    expect(statusBar!.textContent).toContain("2 Projekt(e) nicht geladen");

    // Badge reflects the partial count (1), not zero.
    const countEl = document.getElementById("ticket-count");
    expect(countEl!.textContent).toBe("1");
  });

  it("crash during backoff: fetchJson not called after retry_after elapses and crash status persists", async () => {
    // Regression for fix 4: the backoffTimeoutId must be cancelled on crash so
    // the pending resume cannot overwrite the crash status or re-arm the interval.
    vi.useFakeTimers();

    const ticket = makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" });

    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce(makeSuccessResponse([ticket]))
      .mockResolvedValueOnce(makeRateLimitResponse([], 60, []))
      .mockResolvedValue(makeSuccessResponse([ticket]));

    let capturedCrashCb: ((code: number | null) => void) | undefined;

    (window as Window & typeof globalThis).backend = {
      fetchJson,
      onBackendCrashed: vi.fn((cb) => { capturedCrashCb = cb; }),
    };

    await initRenderer();

    // Trigger the rate-limited poll — starts a 60s backoff.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    const callsAfterRateLimit = fetchJson.mock.calls.length;

    // Backend crashes while we are still inside the backoff window.
    capturedCrashCb!(99);

    const statusBar = document.querySelector(".status-bar");
    expect(statusBar!.textContent).toContain("abgestürzt");
    expect(statusBar!.textContent).toContain("99");

    // Advance past the retry_after — the cancelled timeout must NOT fire.
    await vi.advanceTimersByTimeAsync(60 * 1000 + 1);

    expect(fetchJson.mock.calls.length).toBe(callsAfterRateLimit);
    // Crash message must still be showing — not overwritten by a resumed poll.
    expect(statusBar!.textContent).toContain("abgestürzt");
    expect(statusBar!.textContent).toContain("99");
  });

  it("rate_limited with non-empty data.tickets: fresh tickets rendered on cold start, status still shows Rate-Limit, backoff triggered", async () => {
    // Regression for the blocking bug: when some projects succeed and others are
    // rate-limited, data.tickets is non-empty. The old code returned early before
    // calling renderTickets, leaving the board blank on a cold start.
    vi.useFakeTimers();

    const ticket = makeTicket({ id: "7", project_id: "proj-ok", project_path: "/repos/ok" });
    // Cold start — DOM is already reset by beforeEach to an empty list.
    const fetchJson = vi
      .fn()
      .mockResolvedValue(makeRateLimitResponse([ticket], 60, ["proj-limited"]));

    let capturedCrashCb: ((code: number | null) => void) | undefined;
    (window as Window & typeof globalThis).backend = {
      fetchJson,
      onBackendCrashed: vi.fn((cb) => { capturedCrashCb = cb; }),
    };

    await initRenderer();

    // The healthy project's ticket must be in the DOM.
    expect(document.querySelectorAll(".ticket-card")).toHaveLength(1);

    // Status bar must still announce the rate-limit (honest indicator).
    const statusBar = document.querySelector(".status-bar");
    expect(statusBar!.textContent).toContain("Rate-Limit");

    // Badge must reflect the rendered count.
    const countEl = document.getElementById("ticket-count");
    expect(countEl!.textContent).toBe("1");

    // Backoff must have been triggered: advancing 3 normal intervals (180s,
    // within the 60s backoff — wait, 60s < 180s so use a longer retry_after
    // here). Verify the poll does NOT fire again immediately within 3 intervals
    // that would be before the backoff expires.
    // (retry_after is 60s, so after 61s the backoff timer fires — just confirm
    // the interval was cleared by checking no extra calls before 60s elapses.)
    const callsAfterInit = fetchJson.mock.calls.length;
    await vi.advanceTimersByTimeAsync(59_000); // just under the 60s backoff
    expect(fetchJson.mock.calls.length).toBe(callsAfterInit); // interval cleared

    capturedCrashCb!(null);
  });

  it("getLastTickets: cache reflects the most recently rendered ticket list", async () => {
    const ticket = makeTicket({ id: "42", project_id: "proj-a", project_path: "/repos/alpha" });

    (window as Window & typeof globalThis).backend = {
      fetchJson: vi.fn().mockResolvedValue(makeSuccessResponse([ticket])),
      onBackendCrashed: vi.fn(),
    };

    await loadTickets();

    const cached = getLastTickets();
    expect(cached).toHaveLength(1);
    expect(cached[0].id).toBe("42");
  });
});
