// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderTickets, loadTickets, initRenderer, POLL_INTERVAL_MS } from "./renderer.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal TicketRow fixture — only the fields renderTickets actually uses. */
function makeTicket(overrides: {
  id?: string;
  title?: string;
  status?: string;
  url?: string;
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
    labels: overrides.labels ?? [],
    provider: overrides.provider ?? "github",
    project_id: overrides.project_id,
    project_path: overrides.project_path,
    pull_request: overrides.pull_request !== undefined ? overrides.pull_request : null,
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
      fetchJson: vi.fn().mockResolvedValue({ ok: true, status: 200, data: tickets }),
      onBackendCrashed: vi.fn(),
    };

    await loadTickets();

    const countEl = document.getElementById("ticket-count");
    expect(countEl!.textContent).toBe("3");
  });

  it("empty list: #ticket-count is '0' and status bar shows 'Keine offenen Tickets'", async () => {
    (window as Window & typeof globalThis).backend = {
      fetchJson: vi.fn().mockResolvedValue({ ok: true, status: 200, data: [] }),
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
      fetchJson: vi.fn().mockResolvedValue({ ok: true, status: 200, data: tickets }),
      onBackendCrashed: vi.fn(),
    };

    await loadTickets();

    const list = document.getElementById("ticket-list")!;
    const headers = list.querySelectorAll(".project-group-header");
    expect(headers).toHaveLength(2);
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
    const fetchJson = vi.fn().mockResolvedValue({ ok: true, status: 200, data: tickets });
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
      .mockResolvedValueOnce({ ok: true, status: 200, data: [ticket] })
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

    const fetchJson = vi.fn().mockResolvedValue({ ok: true, status: 200, data: [] });
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

    const fetchJson = vi.fn().mockResolvedValue({ ok: true, status: 200, data: [] });
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
    const fetchJson = vi.fn().mockResolvedValue({ ok: true, status: 200, data: [ticket] });
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
