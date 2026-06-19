// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { DetailView } from "./detail/DetailView";
import type { DetailTicket } from "./types";

// ---------------------------------------------------------------------------
// Mock window.detail since we're in jsdom (no Electron preload)
// ---------------------------------------------------------------------------

function setupDetailMock(openExternal?: ReturnType<typeof vi.fn>) {
  (window as Window & typeof globalThis).detail = {
    openTicketDetail: vi.fn(),
    onTicketDetailData: vi.fn(),
    openExternal: openExternal ?? vi.fn(() => Promise.resolve()),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestDetailTicket {
  id?: string;
  title?: string;
  body?: string;
  url?: string;
  status?: string;
  pull_request?: { url: string; status: string } | null;
}

function makeDetailTicket(overrides: Partial<TestDetailTicket> = {}): DetailTicket {
  return {
    id: overrides.id ?? "T-42",
    title: overrides.title ?? "Fix the login bug",
    body: overrides.body ?? "Steps to reproduce…",
    url: overrides.url ?? "https://github.com/org/repo/issues/18",
    status: overrides.status ?? "open",
    pull_request: overrides.pull_request !== undefined ? overrides.pull_request : null,
  };
}

// Helper: query within the rendered container using CSS class selectors.
// Avoids the jsdom duplicate-ID issue where container.querySelector("#id")
// returns null when the same ID was used in a prior render in the same file.
function q(container: HTMLElement, selector: string): HTMLElement | null {
  return container.querySelector(selector) as HTMLElement | null;
}

// ---------------------------------------------------------------------------
// render — title and body (Markdown)
// ---------------------------------------------------------------------------

describe("DetailView — title and body", () => {
  beforeEach(() => setupDetailMock());

  it("sets #detail-title text to the ticket title", () => {
    const { container } = render(
      <DetailView ticket={makeDetailTicket({ title: "Fix the login bug" })} />
    );
    const el = q(container, ".detail-title");
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe("Fix the login bug");
  });

  it("renders Markdown body: h1 and strong present in innerHTML", () => {
    const { container } = render(
      <DetailView ticket={makeDetailTicket({ body: "# Heading\n\nSome **bold** text" })} />
    );
    const bodyEl = q(container, ".detail-body-md");
    expect(bodyEl).not.toBeNull();
    expect(bodyEl!.innerHTML).toContain("<h1");
    expect(bodyEl!.innerHTML).toContain("<strong");
    expect(bodyEl!.textContent).not.toBe("# Heading\n\nSome **bold** text");
  });

  it("body undefined renders without crashing and produces near-empty output", () => {
    const ticket: DetailTicket = { title: "No body ticket", url: "https://example.com" };
    let bodyEl: HTMLElement | null = null;
    expect(() => {
      const { container } = render(<DetailView ticket={ticket} />);
      bodyEl = q(container, ".detail-body-md");
    }).not.toThrow();
    expect(bodyEl).not.toBeNull();
    expect(bodyEl!.textContent?.trim() ?? "").toBe("");
  });

  it("body empty string renders without crashing", () => {
    expect(() =>
      render(<DetailView ticket={makeDetailTicket({ body: "" })} />)
    ).not.toThrow();
  });

  it("body whitespace-only renders without crashing", () => {
    expect(() =>
      render(<DetailView ticket={makeDetailTicket({ body: "   " })} />)
    ).not.toThrow();
  });

  it("title undefined renders empty string without crashing", () => {
    const ticket: DetailTicket = { body: "some body", url: "https://example.com" };
    expect(() => {
      const { container } = render(<DetailView ticket={ticket} />);
      const titleEl = q(container, ".detail-title");
      expect(titleEl!.textContent).toBe("");
    }).not.toThrow();
  });

  it("null ticket renders nothing (null)", () => {
    const { container } = render(<DetailView ticket={null} />);
    expect(container.firstChild).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// render — XSS sanitization (real DOMPurify)
// ---------------------------------------------------------------------------

describe("DetailView — XSS sanitization", () => {
  beforeEach(() => setupDetailMock());

  it("sanitizes <script> tags from body", () => {
    const { container } = render(
      <DetailView ticket={makeDetailTicket({ body: "<script>alert(1)</script>" })} />
    );
    const bodyEl = q(container, ".detail-body-md");
    expect(bodyEl).not.toBeNull();
    expect(bodyEl!.innerHTML).not.toContain("<script");
  });

  it("sanitizes onerror attributes from body", () => {
    const { container } = render(
      <DetailView ticket={makeDetailTicket({ body: '<img src=x onerror=alert(1)>' })} />
    );
    const bodyEl = q(container, ".detail-body-md");
    expect(bodyEl).not.toBeNull();
    expect(bodyEl!.innerHTML).not.toContain("onerror");
  });
});

// ---------------------------------------------------------------------------
// render — GitHub link
// ---------------------------------------------------------------------------

describe("DetailView — GitHub link", () => {
  it("clicking the Issue button calls window.detail.openExternal with the ticket url", async () => {
    const openExternal = vi.fn(() => Promise.resolve());
    setupDetailMock(openExternal);

    const { container } = render(
      <DetailView ticket={makeDetailTicket({ url: "https://github.com/org/repo/issues/18" })} />
    );

    const btn = q(container, '[id="detail-gh-btn"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();

    await act(async () => {
      btn.click();
    });

    expect(openExternal).toHaveBeenCalledWith("https://github.com/org/repo/issues/18");
  });
});

// ---------------------------------------------------------------------------
// render — link delegation in body (Markdown links)
// ---------------------------------------------------------------------------

describe("DetailView — link delegation in body", () => {
  it("clicking a http link in the rendered Markdown body calls openExternal and preventDefault", async () => {
    const openExternal = vi.fn(() => Promise.resolve());
    setupDetailMock(openExternal);

    const { container } = render(
      <DetailView ticket={makeDetailTicket({ body: "[click me](https://example.com)" })} />
    );

    const bodyContainer = q(container, ".detail-body-md")!;
    expect(bodyContainer).not.toBeNull();
    const anchor = bodyContainer.querySelector("a") as HTMLAnchorElement | null;
    expect(anchor).not.toBeNull();

    const fakeEvent = new MouseEvent("click", { bubbles: true, cancelable: true });
    const preventDefaultSpy = vi.spyOn(fakeEvent, "preventDefault");

    await act(async () => {
      anchor!.dispatchEvent(fakeEvent);
    });

    expect(openExternal).toHaveBeenCalledWith(expect.stringContaining("example.com"));
    expect(preventDefaultSpy).toHaveBeenCalled();
  });

  it("http(s) guard: file:// link does NOT call openExternal (navigation silently swallowed)", async () => {
    const openExternal = vi.fn(() => Promise.resolve());
    setupDetailMock(openExternal);

    const { container } = render(
      <DetailView ticket={makeDetailTicket({ body: "" })} />
    );

    const bodyContainer = q(container, ".detail-body-md")!;
    expect(bodyContainer).not.toBeNull();
    bodyContainer.innerHTML = '<a href="file:///app/resources/CONTRIBUTING.md">docs</a>';

    const anchor = bodyContainer.querySelector("a") as HTMLAnchorElement;
    expect(anchor.href).toMatch(/^file:\/\//);

    await act(async () => {
      anchor.click();
    });

    expect(openExternal).not.toHaveBeenCalled();
  });

  it("re-render does not double-fire openExternal per click (delegation bound once via useEffect)", async () => {
    const openExternal = vi.fn(() => Promise.resolve());
    setupDetailMock(openExternal);

    // First render
    const { container, rerender } = render(
      <DetailView ticket={makeDetailTicket({ body: "[click me](https://example.com)" })} />
    );

    // Second render (simulates a second ticket arriving)
    await act(async () => {
      rerender(<DetailView ticket={makeDetailTicket({ body: "[click me](https://example.com)" })} />);
    });

    const bodyContainer = q(container, ".detail-body-md")!;
    const anchor = bodyContainer.querySelector("a")!;

    await act(async () => {
      anchor.click();
    });

    // One click → one call (not doubled by multiple event listeners)
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(expect.stringContaining("example.com"));
  });
});

// ---------------------------------------------------------------------------
// render — PR section
// ---------------------------------------------------------------------------

describe("DetailView — PR section", () => {
  beforeEach(() => setupDetailMock());

  it("PR button is absent when pull_request is null", () => {
    const { container } = render(
      <DetailView ticket={makeDetailTicket({ pull_request: null })} />
    );
    expect(q(container, '[id="detail-pr-btn"]')).toBeNull();
  });

  it("PR button is absent when pull_request is undefined", () => {
    const ticket: DetailTicket = { title: "T", url: "https://example.com" };
    const { container } = render(<DetailView ticket={ticket} />);
    expect(q(container, '[id="detail-pr-btn"]')).toBeNull();
  });

  it("PR button is present when pull_request is non-null", () => {
    const { container } = render(
      <DetailView ticket={makeDetailTicket({
        pull_request: { url: "https://github.com/org/repo/pull/5", status: "open" },
      })} />
    );
    expect(q(container, '[id="detail-pr-btn"]')).not.toBeNull();
  });

  it("clicking the PR button calls window.detail.openExternal with the PR url", async () => {
    const openExternal = vi.fn(() => Promise.resolve());
    setupDetailMock(openExternal);

    const prUrl = "https://github.com/org/repo/pull/5";
    const { container } = render(
      <DetailView ticket={makeDetailTicket({
        pull_request: { url: prUrl, status: "open" },
      })} />
    );

    const prBtn = q(container, '[id="detail-pr-btn"]') as HTMLButtonElement;
    expect(prBtn).not.toBeNull();

    await act(async () => {
      prBtn.click();
    });

    expect(openExternal).toHaveBeenCalledWith(prUrl);
  });

  it("regression: switching from PR ticket to no-PR ticket removes the PR button", () => {
    const { container, rerender } = render(
      <DetailView ticket={makeDetailTicket({
        pull_request: { url: "https://github.com/org/repo/pull/5", status: "open" },
      })} />
    );
    expect(q(container, '[id="detail-pr-btn"]')).not.toBeNull();

    rerender(<DetailView ticket={makeDetailTicket({ pull_request: null })} />);
    expect(q(container, '[id="detail-pr-btn"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Browser context: window.backend absent
// ---------------------------------------------------------------------------

describe("DetailView — browser context (no Electron)", () => {
  it("renders without throwing when window.detail is not set (no Electron preload)", () => {
    const saved = (window as Window & typeof globalThis).detail;
    // @ts-ignore
    delete (window as Window & typeof globalThis).detail;

    expect(() => {
      render(<DetailView ticket={makeDetailTicket()} />);
    }).not.toThrow();

    // Restore
    (window as Window & typeof globalThis).detail = saved;
  });
});

// ---------------------------------------------------------------------------
// Fix #4: openExternal prop — browser fallback path
// ---------------------------------------------------------------------------

describe("DetailView — openExternal prop (browser fallback)", () => {
  it("uses the provided openExternal prop instead of window.detail.openExternal", async () => {
    setupDetailMock(); // window.detail present but its openExternal must NOT be called
    const propOpenExternal = vi.fn();

    const { container } = render(
      <DetailView
        ticket={makeDetailTicket({ url: "https://github.com/org/repo/issues/18" })}
        openExternal={propOpenExternal}
      />
    );

    const btn = q(container, '[id="detail-gh-btn"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();

    await act(async () => {
      btn.click();
    });

    expect(propOpenExternal).toHaveBeenCalledWith("https://github.com/org/repo/issues/18");
    expect((window as Window & typeof globalThis).detail?.openExternal).not.toHaveBeenCalled();
  });

  it("falls back to window.open when window.detail is absent and no prop provided", async () => {
    const saved = (window as Window & typeof globalThis).detail;
    // @ts-ignore
    delete (window as Window & typeof globalThis).detail;

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    const { container } = render(
      <DetailView ticket={makeDetailTicket({ url: "https://github.com/org/repo/issues/99" })} />
    );

    const btn = q(container, '[id="detail-gh-btn"]') as HTMLButtonElement;
    expect(btn).not.toBeNull();

    await act(async () => {
      btn.click();
    });

    expect(openSpy).toHaveBeenCalledWith(
      "https://github.com/org/repo/issues/99",
      "_blank",
      "noopener"
    );

    openSpy.mockRestore();
    (window as Window & typeof globalThis).detail = saved;
  });
});

// ---------------------------------------------------------------------------
// Fix #59: project name in detail header
// ---------------------------------------------------------------------------

describe("DetailView — project name in header", () => {
  beforeEach(() => setupDetailMock());

  it("renders .detail-project-name with correct text when project_path is set", () => {
    const ticket: DetailTicket = {
      ...makeDetailTicket(),
      project_path: "/repos/my-project",
    };
    const { container } = render(<DetailView ticket={ticket} />);
    const el = q(container, ".detail-project-name");
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe("/repos/my-project");
  });

  it("does NOT render .detail-project-name when project_path is absent", () => {
    const ticket: DetailTicket = makeDetailTicket();
    // makeDetailTicket does not set project_path, so it is undefined.
    const { container } = render(<DetailView ticket={ticket} />);
    const el = q(container, ".detail-project-name");
    expect(el).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fix #69: label chips in detail-sub-row
// ---------------------------------------------------------------------------

describe("DetailView — label chips in detail-sub-row", () => {
  beforeEach(() => setupDetailMock());

  it("renders one .card-label-chip per label inside .detail-sub-row", () => {
    const ticket: DetailTicket = { ...makeDetailTicket(), labels: ["bug", "frontend"] };
    const { container } = render(<DetailView ticket={ticket} />);
    const subRow = q(container, ".detail-sub-row")!;
    expect(subRow).not.toBeNull();
    const chips = subRow.querySelectorAll(".card-label-chip");
    expect(chips).toHaveLength(2);
    expect(chips[0].textContent).toBe("bug");
    expect(chips[1].textContent).toBe("frontend");
  });

  it("renders no .card-label-chip inside .detail-sub-row when labels is empty", () => {
    const ticket: DetailTicket = { ...makeDetailTicket(), labels: [] };
    const { container } = render(<DetailView ticket={ticket} />);
    const subRow = q(container, ".detail-sub-row")!;
    expect(subRow).not.toBeNull();
    const chips = subRow.querySelectorAll(".card-label-chip");
    expect(chips).toHaveLength(0);
  });

  it("renders no .card-label-chip when labels is undefined", () => {
    const ticket: DetailTicket = makeDetailTicket(); // labels not set
    const { container } = render(<DetailView ticket={ticket} />);
    const subRow = q(container, ".detail-sub-row")!;
    expect(subRow).not.toBeNull();
    const chips = subRow.querySelectorAll(".card-label-chip");
    expect(chips).toHaveLength(0);
  });

  it("regression: #detail-gh-link anchor is absent (replaced by label chips)", () => {
    const { container } = render(<DetailView ticket={makeDetailTicket()} />);
    expect(q(container, "#detail-gh-link")).toBeNull();
  });

  it("Issue button (#detail-gh-btn) has text 'Issue'", () => {
    const { container } = render(<DetailView ticket={makeDetailTicket()} />);
    const btn = q(container, '[id="detail-gh-btn"]');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe("Issue");
  });

  it("regression: #detail-close-footer button is absent", () => {
    const { container } = render(<DetailView ticket={makeDetailTicket()} />);
    expect(q(container, "#detail-close-footer")).toBeNull();
  });
});
