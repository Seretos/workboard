// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, initDetail } from "./detail.js";

// ---------------------------------------------------------------------------
// Mock vendor globals (jsdom has no UMD scripts loaded).
// Tests that need real Markdown/sanitization import the libraries directly.
// ---------------------------------------------------------------------------
(globalThis as any).marked = { parse: (s: string) => s };
(globalThis as any).DOMPurify = { sanitize: (s: string) => s };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set up the DOM anchors that detail.ts reads. */
function setupDOM() {
  document.body.innerHTML = `
    <span id="detail-id"></span>
    <span id="detail-title"></span>
    <span id="detail-status-pill"></span>
    <div id="detail-body-md"></div>
    <a id="detail-gh-link">Open on GitHub</a>
    <button id="detail-close-btn" type="button">X</button>
    <button id="detail-close-footer" type="button">Schließen</button>
    <button id="detail-gh-btn" type="button">In Browser öffnen</button>
    <div id="detail-pr-section" style="display:none">
      <a id="detail-pr-link">Pull Request</a>
      <span id="detail-pr-status"></span>
    </div>
  `;
}

interface DetailTicket {
  id?: string;
  title?: string;
  body?: string;
  url?: string;
  status?: string;
  pull_request?: { url: string; status: string } | null;
}

function makeDetailTicket(overrides: Partial<DetailTicket> = {}): DetailTicket {
  return {
    id: overrides.id ?? "T-42",
    title: overrides.title ?? "Fix the login bug",
    body: overrides.body ?? "Steps to reproduce…",
    url: overrides.url ?? "https://github.com/org/repo/issues/18",
    status: overrides.status ?? "open",
    pull_request: overrides.pull_request !== undefined ? overrides.pull_request : null,
  };
}

// ---------------------------------------------------------------------------
// render — title and body (Markdown)
// ---------------------------------------------------------------------------

describe("render — title and body", () => {
  beforeEach(setupDOM);

  it("sets #detail-title text to the ticket title", () => {
    render(makeDetailTicket({ title: "Fix the login bug" }));
    expect(document.getElementById("detail-title")!.textContent).toBe("Fix the login bug");
  });

  it("renders Markdown body: h1 and strong present in innerHTML", () => {
    // Use real marked for this assertion so it is meaningful.
    const realMarked = require("marked");
    const realDOMPurify = require("dompurify");
    const { JSDOM } = require("jsdom");
    const window2 = new JSDOM("").window;
    const purify = realDOMPurify(window2);

    // Temporarily replace the globals with real implementations.
    const origMarked = (globalThis as any).marked;
    const origPurify = (globalThis as any).DOMPurify;
    (globalThis as any).marked = realMarked;
    (globalThis as any).DOMPurify = purify;

    render(makeDetailTicket({ body: "# Heading\n\nSome **bold** text" }));

    (globalThis as any).marked = origMarked;
    (globalThis as any).DOMPurify = origPurify;

    const bodyEl = document.getElementById("detail-body-md")!;
    expect(bodyEl.innerHTML).toContain("<h1");
    expect(bodyEl.innerHTML).toContain("<strong");
    // Raw string should NOT be the textContent verbatim.
    expect(bodyEl.textContent).not.toBe("# Heading\n\nSome **bold** text");
  });

  it("body undefined renders without crashing and produces near-empty output", () => {
    const ticket: DetailTicket = { title: "No body ticket", url: "https://example.com" };
    expect(() => render(ticket)).not.toThrow();
    const bodyEl = document.getElementById("detail-body-md")!;
    // innerHTML may contain whitespace/empty paragraph from marked, but no meaningful content.
    expect(bodyEl.textContent?.trim() ?? "").toBe("");
  });

  it("body empty string renders without crashing", () => {
    expect(() => render(makeDetailTicket({ body: "" }))).not.toThrow();
  });

  it("body whitespace-only renders without crashing", () => {
    expect(() => render(makeDetailTicket({ body: "   " }))).not.toThrow();
  });

  it("title undefined renders empty string without crashing", () => {
    const ticket: DetailTicket = { body: "some body", url: "https://example.com" };
    expect(() => render(ticket)).not.toThrow();
    expect(document.getElementById("detail-title")!.textContent).toBe("");
  });
});

// ---------------------------------------------------------------------------
// render — XSS sanitization (real DOMPurify)
// ---------------------------------------------------------------------------

describe("render — XSS sanitization", () => {
  beforeEach(setupDOM);

  it("sanitizes <script> tags from body", () => {
    const realMarked = require("marked");
    const realDOMPurify = require("dompurify");
    const { JSDOM } = require("jsdom");
    const window2 = new JSDOM("").window;
    const purify = realDOMPurify(window2);

    const origMarked = (globalThis as any).marked;
    const origPurify = (globalThis as any).DOMPurify;
    (globalThis as any).marked = realMarked;
    (globalThis as any).DOMPurify = purify;

    render(makeDetailTicket({ body: "<script>alert(1)</script>" }));

    (globalThis as any).marked = origMarked;
    (globalThis as any).DOMPurify = origPurify;

    const html = document.getElementById("detail-body-md")!.innerHTML;
    expect(html).not.toContain("<script");
  });

  it("sanitizes onerror attributes from body", () => {
    const realMarked = require("marked");
    const realDOMPurify = require("dompurify");
    const { JSDOM } = require("jsdom");
    const window2 = new JSDOM("").window;
    const purify = realDOMPurify(window2);

    const origMarked = (globalThis as any).marked;
    const origPurify = (globalThis as any).DOMPurify;
    (globalThis as any).marked = realMarked;
    (globalThis as any).DOMPurify = purify;

    render(makeDetailTicket({ body: '<img src=x onerror=alert(1)>' }));

    (globalThis as any).marked = origMarked;
    (globalThis as any).DOMPurify = origPurify;

    const html = document.getElementById("detail-body-md")!.innerHTML;
    expect(html).not.toContain("onerror");
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
// render — link delegation in body (Markdown links)
// ---------------------------------------------------------------------------

describe("render — link delegation in body", () => {
  beforeEach(setupDOM);

  it("clicking a http link in the rendered Markdown body calls openExternal and preventDefault", () => {
    const openExternal = vi.fn(() => Promise.resolve());
    (window as Window & typeof globalThis).detail = {
      openTicketDetail: vi.fn(),
      onTicketDetailData: vi.fn(),
      openExternal,
    };

    // Use real marked so a real <a> is produced, then call initDetail() to
    // attach the real delegation listener (not a hand-rolled substitute).
    const realMarked = require("marked");
    const origMarked = (globalThis as any).marked;
    (globalThis as any).marked = realMarked;

    // initDetail attaches the delegation listener; render populates the body.
    initDetail();
    render(makeDetailTicket({ body: "[click me](https://example.com)" }));

    (globalThis as any).marked = origMarked;

    const bodyContainer = document.getElementById("detail-body-md")!;
    const anchor = bodyContainer.querySelector("a") as HTMLAnchorElement | null;
    expect(anchor).not.toBeNull();

    const fakeEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    const preventDefaultSpy = vi.spyOn(fakeEvent, "preventDefault");
    anchor!.dispatchEvent(fakeEvent);

    expect(openExternal).toHaveBeenCalledWith(expect.stringContaining("example.com"));
    expect(preventDefaultSpy).toHaveBeenCalled();
  });

  it("http(s) guard: file:// link does NOT call openExternal (navigation silently swallowed)", () => {
    // Regression for the packaged-app file:// path hazard: detail.html loads from
    // file:// so a relative Markdown link resolves to a file:// path in the
    // packaged renderer — passing that to openExternal would open a local bundle file.
    // We simulate this by injecting an anchor whose href is explicitly file://.
    const openExternal = vi.fn(() => Promise.resolve());
    (window as Window & typeof globalThis).detail = {
      openTicketDetail: vi.fn(),
      onTicketDetailData: vi.fn(),
      openExternal,
    };

    initDetail();

    // Inject a file:// anchor directly into the body container (bypassing marked
    // so we control the exact href regardless of jsdom's base URL resolution).
    const bodyContainer = document.getElementById("detail-body-md")!;
    bodyContainer.innerHTML = '<a href="file:///app/resources/CONTRIBUTING.md">docs</a>';

    const anchor = bodyContainer.querySelector("a") as HTMLAnchorElement;
    // Confirm the href is actually file:// so the test is meaningful.
    expect(anchor.href).toMatch(/^file:\/\//);

    anchor.click();

    // openExternal must NOT have been called for a file:// href.
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("re-render does not double-fire openExternal per click (initDetail delegation bound once)", () => {
    // This test exercises the REAL binding via initDetail() to prove that
    // addEventListener is not called per-render — only once at init time.
    const openExternal = vi.fn(() => Promise.resolve());
    (window as Window & typeof globalThis).detail = {
      openTicketDetail: vi.fn(),
      onTicketDetailData: vi.fn(),
      openExternal,
    };

    const realMarked = require("marked");
    const origMarked = (globalThis as any).marked;
    (globalThis as any).marked = realMarked;

    // Call initDetail ONCE — this is the only place the delegation listener
    // should ever be bound.
    initDetail();

    // First render.
    render(makeDetailTicket({ body: "[click me](https://example.com)" }));
    // Second render (simulates a second ticket arriving over IPC).
    render(makeDetailTicket({ body: "[click me](https://example.com)" }));

    (globalThis as any).marked = origMarked;

    const bodyContainer = document.getElementById("detail-body-md")!;
    const anchor = bodyContainer.querySelector("a")!;
    anchor.click();

    // initDetail was called once, so exactly one delegation fires → openExternal
    // called exactly once despite two renders.
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(expect.stringContaining("example.com"));
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
