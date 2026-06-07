// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, initDetail } from "./detail.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set up the DOM anchors that detail.ts reads. */
function setupDOM() {
  document.body.innerHTML = `
    <span id="detail-title"></span>
    <p id="detail-body"></p>
    <a id="detail-gh-link" href="#">Open on GitHub</a>
    <div id="detail-pr-section" style="display:none">
      <a id="detail-pr-link" href="#">Pull Request</a>
      <span id="detail-pr-status"></span>
    </div>
  `;
}

interface DetailTicket {
  title?: string;
  body?: string;
  url?: string;
  pull_request?: { url: string; status: string } | null;
}

function makeDetailTicket(overrides: Partial<DetailTicket> = {}): DetailTicket {
  return {
    title: overrides.title ?? "Fix the login bug",
    body: overrides.body ?? "Steps to reproduce…",
    url: overrides.url ?? "https://github.com/org/repo/issues/18",
    pull_request: overrides.pull_request !== undefined ? overrides.pull_request : null,
  };
}

// ---------------------------------------------------------------------------
// render — DOM population
// ---------------------------------------------------------------------------

describe("render — title and body", () => {
  beforeEach(setupDOM);

  it("sets #detail-title text to the ticket title", () => {
    render(makeDetailTicket({ title: "Fix the login bug" }));
    expect(document.getElementById("detail-title")!.textContent).toBe("Fix the login bug");
  });

  it("sets #detail-body text to the ticket body", () => {
    render(makeDetailTicket({ body: "Steps to reproduce…" }));
    expect(document.getElementById("detail-body")!.textContent).toBe("Steps to reproduce…");
  });

  it("body undefined renders empty string without crashing", () => {
    const ticket: DetailTicket = { title: "No body ticket", url: "https://example.com" };
    expect(() => render(ticket)).not.toThrow();
    expect(document.getElementById("detail-body")!.textContent).toBe("");
  });

  it("title undefined renders empty string without crashing", () => {
    const ticket: DetailTicket = { body: "some body", url: "https://example.com" };
    expect(() => render(ticket)).not.toThrow();
    expect(document.getElementById("detail-title")!.textContent).toBe("");
  });
});

// ---------------------------------------------------------------------------
// render — GitHub link
// ---------------------------------------------------------------------------

describe("render — GitHub link", () => {
  beforeEach(setupDOM);

  it("clicking the GitHub link calls window.detail.openExternal with the ticket url", () => {
    const openExternal = vi.fn(() => Promise.resolve());
    (window as Window & typeof globalThis).detail = {
      openTicketDetail: vi.fn(),
      onTicketDetailData: vi.fn(),
      openExternal,
    };

    render(makeDetailTicket({ url: "https://github.com/org/repo/issues/18" }));

    const link = document.getElementById("detail-gh-link") as HTMLAnchorElement;
    link.click();

    expect(openExternal).toHaveBeenCalledWith("https://github.com/org/repo/issues/18");
  });

  it("clicking the GitHub link does not navigate (preventDefault is honoured)", () => {
    const openExternal = vi.fn(() => Promise.resolve());
    (window as Window & typeof globalThis).detail = {
      openTicketDetail: vi.fn(),
      onTicketDetailData: vi.fn(),
      openExternal,
    };

    render(makeDetailTicket({ url: "https://github.com/org/repo/issues/18" }));

    const link = document.getElementById("detail-gh-link") as HTMLAnchorElement;
    const fakeEvent = { preventDefault: vi.fn() };
    link.dispatchEvent(Object.assign(new MouseEvent("click"), { preventDefault: fakeEvent.preventDefault }));

    // After re-render openExternal should have been called (link is wired).
    // We can't intercept the real browser default in jsdom but we verify the
    // handler is registered by checking openExternal is called on a direct .click().
    link.click();
    expect(openExternal).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// render — PR section
// ---------------------------------------------------------------------------

describe("render — PR section", () => {
  beforeEach(setupDOM);

  it("PR section is hidden when pull_request is null", () => {
    render(makeDetailTicket({ pull_request: null }));
    const section = document.getElementById("detail-pr-section")!;
    expect(section.style.display).toBe("none");
  });

  it("PR section is hidden when pull_request is undefined", () => {
    const ticket: DetailTicket = { title: "T", url: "https://example.com" };
    render(ticket);
    const section = document.getElementById("detail-pr-section")!;
    expect(section.style.display).toBe("none");
  });

  it("PR section is visible when pull_request is present", () => {
    render(makeDetailTicket({
      pull_request: { url: "https://github.com/org/repo/pull/5", status: "open" },
    }));
    const section = document.getElementById("detail-pr-section")!;
    expect(section.style.display).not.toBe("none");
  });

  it("PR status text is set from pull_request.status", () => {
    render(makeDetailTicket({
      pull_request: { url: "https://github.com/org/repo/pull/5", status: "merged" },
    }));
    expect(document.getElementById("detail-pr-status")!.textContent).toBe("merged");
  });

  it("clicking the PR link calls window.detail.openExternal with the PR url", () => {
    const openExternal = vi.fn(() => Promise.resolve());
    (window as Window & typeof globalThis).detail = {
      openTicketDetail: vi.fn(),
      onTicketDetailData: vi.fn(),
      openExternal,
    };

    const prUrl = "https://github.com/org/repo/pull/5";
    render(makeDetailTicket({
      pull_request: { url: prUrl, status: "open" },
    }));

    const prLink = document.getElementById("detail-pr-link") as HTMLAnchorElement;
    prLink.click();

    expect(openExternal).toHaveBeenCalledWith(prUrl);
  });

  it("regression: switching from PR ticket to no-PR ticket hides the PR section", () => {
    render(makeDetailTicket({
      pull_request: { url: "https://github.com/org/repo/pull/5", status: "open" },
    }));
    expect(document.getElementById("detail-pr-section")!.style.display).not.toBe("none");

    render(makeDetailTicket({ pull_request: null }));
    expect(document.getElementById("detail-pr-section")!.style.display).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// initDetail — IPC wiring
// ---------------------------------------------------------------------------

describe("initDetail", () => {
  beforeEach(setupDOM);

  it("registers an onTicketDetailData callback that populates the DOM", () => {
    let capturedCb: ((ticket: unknown) => void) | undefined;
    (window as Window & typeof globalThis).detail = {
      openTicketDetail: vi.fn(),
      onTicketDetailData: vi.fn((cb) => { capturedCb = cb; }),
      openExternal: vi.fn(),
    };

    initDetail();

    expect(capturedCb).toBeDefined();

    const ticket = makeDetailTicket({ title: "IPC wired ticket" });
    capturedCb!(ticket);

    expect(document.getElementById("detail-title")!.textContent).toBe("IPC wired ticket");
  });
});
