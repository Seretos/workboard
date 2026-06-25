// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TicketList } from "./components/TicketList";
import { TicketCard } from "./components/TicketCard";
import { BrowserDetailPresenter } from "./detail/BrowserDetailPresenter";
import { ElectronDetailPresenter } from "./detail/ElectronDetailPresenter";
import type { TicketRow } from "./types";
import type { DetailPresenter } from "./detail/DetailPresenter";
import type { DetailTicket } from "./types";
import type { TicketsClient } from "./client/TicketsClient";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  worktree?: { id: string; path: string; branch: string; status: string } | null;
}): TicketRow {
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
    worktree: overrides.worktree !== undefined ? overrides.worktree : null,
  };
}

function makePresenter(activeId: string | null = null): { presenter: DetailPresenter; open: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  const open = vi.fn() as (ticket: DetailTicket) => void;
  const close = vi.fn() as () => void;
  return { presenter: { open, close, getActiveId: vi.fn().mockReturnValue(activeId) }, open, close };
}

function makeClient(): TicketsClient {
  return {
    fetchJson: vi.fn().mockResolvedValue({ ok: true, status: 200, data: null }),
    onBackendCrashed: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// TicketList — grouping
// ---------------------------------------------------------------------------

describe("TicketList — grouping", () => {
  it("two projects: renders exactly 2 .project-group-header elements", () => {
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "2", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "3", project_id: "proj-b", project_path: "/repos/beta" }),
      makeTicket({ id: "4", project_id: "proj-b", project_path: "/repos/beta" }),
      makeTicket({ id: "5", project_id: "proj-b", project_path: "/repos/beta" }),
    ];
    const { presenter } = makePresenter();
    const { container } = render(<TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} activeTicketId={null} />);

    const headers = container.querySelectorAll(".project-group-header");
    expect(headers).toHaveLength(2);
  });

  it("two projects: first header text includes correct project_path", () => {
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "2", project_id: "proj-b", project_path: "/repos/beta" }),
    ];
    const { presenter } = makePresenter();
    const { container } = render(<TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} activeTicketId={null} />);

    const headers = container.querySelectorAll(".project-group-header");
    expect(headers[0].textContent).toContain("/repos/alpha");
    expect(headers[1].textContent).toContain("/repos/beta");
  });

  it("two projects: each header badge shows per-group ticket count", () => {
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "2", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "3", project_id: "proj-b", project_path: "/repos/beta" }),
      makeTicket({ id: "4", project_id: "proj-b", project_path: "/repos/beta" }),
      makeTicket({ id: "5", project_id: "proj-b", project_path: "/repos/beta" }),
    ];
    const { presenter } = makePresenter();
    const { container } = render(<TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} activeTicketId={null} />);

    const badges = container.querySelectorAll(".project-group-header .group-count");
    expect(badges[0].textContent).toBe("2");
    expect(badges[1].textContent).toBe("3");
  });

  it("single project: renders exactly 1 .project-group-header element", () => {
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "2", project_id: "proj-a", project_path: "/repos/alpha" }),
    ];
    const { presenter } = makePresenter();
    const { container } = render(<TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} activeTicketId={null} />);

    const headers = container.querySelectorAll(".project-group-header");
    expect(headers).toHaveLength(1);
  });

  it("all 5 ticket cards appear after headers (no interleaving with wrong group)", () => {
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "2", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "3", project_id: "proj-b", project_path: "/repos/beta" }),
      makeTicket({ id: "4", project_id: "proj-b", project_path: "/repos/beta" }),
      makeTicket({ id: "5", project_id: "proj-b", project_path: "/repos/beta" }),
    ];
    const { presenter } = makePresenter();
    const { container } = render(<TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} activeTicketId={null} />);

    const list = container.querySelector("ul")!;
    const items = Array.from(list.children);
    // Order: header-A, card-A1, card-A2, header-B, card-B3, card-B4, card-B5
    expect(items).toHaveLength(7);
    expect(items[0].classList.contains("project-group-header")).toBe(true);
    expect(items[1].classList.contains("ticket-card")).toBe(true);
    expect(items[2].classList.contains("ticket-card")).toBe(true);
    expect(items[3].classList.contains("project-group-header")).toBe(true);
    expect(items[4].classList.contains("ticket-card")).toBe(true);
    expect(items[5].classList.contains("ticket-card")).toBe(true);
    expect(items[6].classList.contains("ticket-card")).toBe(true);
  });

  it("empty ticket list: renders nothing (no headers, no cards)", () => {
    const { presenter } = makePresenter();
    const { container } = render(<TicketList tickets={[]} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} activeTicketId={null} />);

    const list = container.querySelector("ul")!;
    expect(list.children).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// TicketCard / TicketList — PR accent
// ---------------------------------------------------------------------------

describe("TicketList — PR accent", () => {
  it("ticket with pull_request object gets class ticket-card--has-pr", () => {
    const tickets = [
      makeTicket({
        id: "1",
        project_id: "proj-a",
        project_path: "/repos/alpha",
        pull_request: { number: 42, url: "https://github.com/x/y/pull/42", status: "open", draft: false },
      }),
    ];
    const { presenter } = makePresenter();
    const { container } = render(<TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} activeTicketId={null} />);

    const card = container.querySelector(".ticket-card");
    expect(card).not.toBeNull();
    expect(card!.classList.contains("ticket-card--has-pr")).toBe(true);
  });

  it("ticket with pull_request: null does NOT get class ticket-card--has-pr", () => {
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha", pull_request: null }),
    ];
    const { presenter } = makePresenter();
    const { container } = render(<TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} activeTicketId={null} />);

    const card = container.querySelector(".ticket-card");
    expect(card).not.toBeNull();
    expect(card!.classList.contains("ticket-card--has-pr")).toBe(false);
  });

  it("ticket with pull_request field absent (undefined) does NOT get class ticket-card--has-pr", () => {
    const ticket = {
      id: "1",
      title: "Old ticket",
      status: "open",
      url: "https://example.com",
      labels: [] as string[],
      provider: "github",
      project_id: "proj-a",
      project_path: "/repos/alpha",
      // pull_request intentionally absent
    } as TicketRow;
    const { presenter } = makePresenter();
    const { container } = render(<TicketList tickets={[ticket]} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} activeTicketId={null} />);

    const card = container.querySelector(".ticket-card");
    expect(card).not.toBeNull();
    expect(card!.classList.contains("ticket-card--has-pr")).toBe(false);
  });

  it("mixed tickets: only the one with pull_request gets the PR class", () => {
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
    const { presenter } = makePresenter();
    const { container } = render(<TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} activeTicketId={null} />);

    const cards = container.querySelectorAll(".ticket-card");
    expect(cards).toHaveLength(2);
    expect(cards[0].classList.contains("ticket-card--has-pr")).toBe(true);
    expect(cards[1].classList.contains("ticket-card--has-pr")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TicketList — edge cases
// ---------------------------------------------------------------------------

describe("TicketList — edge cases", () => {
  it("same project_id with different project_path: first path wins for header, no crash", () => {
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/first" }),
      makeTicket({ id: "2", project_id: "proj-a", project_path: "/repos/second" }),
    ];
    const { presenter } = makePresenter();
    expect(() => {
      const { container } = render(<TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} activeTicketId={null} />);
      const headers = container.querySelectorAll(".project-group-header");
      expect(headers).toHaveLength(1);
      expect(headers[0].textContent).toContain("/repos/first");
    }).not.toThrow();
  });

  it("empty project_path: renders without crash", () => {
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "" }),
    ];
    const { presenter } = makePresenter();
    expect(() => {
      const { container } = render(<TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} activeTicketId={null} />);
      const headers = container.querySelectorAll(".project-group-header");
      expect(headers).toHaveLength(1);
    }).not.toThrow();
  });

  it("draft pull_request: still gets ticket-card--has-pr (object is non-null)", () => {
    const tickets = [
      makeTicket({
        id: "1",
        project_id: "proj-a",
        project_path: "/repos/alpha",
        pull_request: { number: 99, url: "https://github.com/x/y/pull/99", status: "draft", draft: true },
      }),
    ];
    const { presenter } = makePresenter();
    const { container } = render(<TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} activeTicketId={null} />);

    const card = container.querySelector(".ticket-card");
    expect(card!.classList.contains("ticket-card--has-pr")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TicketCard — card click opens detail window
// ---------------------------------------------------------------------------

describe("TicketCard — card click", () => {
  it("clicking a ticket card calls presenter.open with the ticket", async () => {
    const ticket = makeTicket({ id: "42", project_id: "proj-a", project_path: "/repos/alpha" });
    const { presenter, open } = makePresenter();

    const { container } = render(<TicketCard ticket={ticket} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} isActive={false} />);
    const card = container.querySelector(".ticket-card") as HTMLElement;
    expect(card).not.toBeNull();

    await userEvent.click(card);

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(ticket);
  });

  it("clicking a card passes the body field to presenter.open", async () => {
    const ticket = makeTicket({
      id: "7",
      body: "This is the ticket description.",
      project_id: "proj-a",
      project_path: "/repos/alpha",
    });
    const { presenter, open } = makePresenter();

    const { container } = render(<TicketCard ticket={ticket} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} isActive={false} />);
    const card = container.querySelector(".ticket-card") as HTMLElement;
    await userEvent.click(card);

    const arg = (open as ReturnType<typeof vi.fn>).mock.calls[0][0] as { body?: string };
    expect(arg.body).toBe("This is the ticket description.");
  });

  it("clicking a card passes the pull_request field to presenter.open", async () => {
    const pr = { number: 10, url: "https://github.com/x/y/pull/10", status: "open", draft: false };
    const ticket = makeTicket({ id: "10", project_id: "proj-a", project_path: "/repos/alpha", pull_request: pr });
    const { presenter, open } = makePresenter();

    const { container } = render(<TicketCard ticket={ticket} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} isActive={false} />);
    const card = container.querySelector(".ticket-card") as HTMLElement;
    await userEvent.click(card);

    const arg = (open as ReturnType<typeof vi.fn>).mock.calls[0][0] as { pull_request: typeof pr };
    expect(arg.pull_request).toEqual(pr);
  });

  it("each card in a multi-card list calls presenter.open with its own ticket", async () => {
    const t1 = makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" });
    const t2 = makeTicket({ id: "2", project_id: "proj-a", project_path: "/repos/alpha" });
    const { presenter, open } = makePresenter();

    const { container } = render(<TicketList tickets={[t1, t2]} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} activeTicketId={null} />);
    const cards = container.querySelectorAll(".ticket-card") as NodeListOf<HTMLElement>;
    expect(cards).toHaveLength(2);

    await userEvent.click(cards[0]);
    expect((open as ReturnType<typeof vi.fn>)).toHaveBeenLastCalledWith(t1);

    await userEvent.click(cards[1]);
    expect((open as ReturnType<typeof vi.fn>)).toHaveBeenLastCalledWith(t2);
  });

  it("second click on the already-active card calls presenter.close, NOT presenter.open", async () => {
    const ticket = makeTicket({ id: "42", project_id: "proj-a", project_path: "/repos/alpha" });
    // presenter reports this ticket as already active
    const { presenter, open, close } = makePresenter("42");

    const { container } = render(<TicketCard ticket={ticket} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} isActive={true} />);
    const card = container.querySelector(".ticket-card") as HTMLElement;

    await userEvent.click(card);

    expect(close).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });

  it("click on a different (inactive) card calls presenter.open, NOT presenter.close", async () => {
    const ticket = makeTicket({ id: "99", project_id: "proj-a", project_path: "/repos/alpha" });
    // presenter reports ticket "42" as active — "99" is a different ticket
    const { presenter, open, close } = makePresenter("42");

    const { container } = render(<TicketCard ticket={ticket} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} isActive={false} />);
    const card = container.querySelector(".ticket-card") as HTMLElement;

    await userEvent.click(card);

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(ticket);
    expect(close).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// TicketCard — worktree create / delete behaviour
// ---------------------------------------------------------------------------

function makeTicketWithWorktree(worktreeId: string = "workboard-fix-42-abcd1234"): TicketRow {
  return {
    ...makeTicket({ id: "42", project_id: "proj-a", project_path: "/repos/alpha" }),
    worktree: { id: worktreeId, path: "/wt/path", branch: "fix/42-test", status: "idle" },
  };
}

describe("TicketCard — create worktree", () => {
  it("clicking 'Worktree erstellen' calls fetchJson with method POST and correct body", async () => {
    const ticket = makeTicket({ id: "42", project_id: "proj-a", project_path: "/repos/alpha" });
    const { presenter } = makePresenter();
    const fetchJson = vi.fn().mockResolvedValue({ ok: true, status: 201, data: { id: "new-id" } });
    const client: TicketsClient = { fetchJson, onBackendCrashed: vi.fn() };
    const onRefresh = vi.fn();

    const { container } = render(
      <TicketCard ticket={ticket} presenter={presenter} client={client} onRefresh={onRefresh} isActive={false} />
    );

    const btn = container.querySelector(".card-worktree-btn") as HTMLElement;
    expect(btn).not.toBeNull();
    await userEvent.click(btn);

    expect(fetchJson).toHaveBeenCalledWith(
      "/worktrees",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"project_id":"proj-a"'),
      })
    );
    const callInit = fetchJson.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(callInit.body as string);
    expect(body.project_id).toBe("proj-a");
    expect(body.ticket_number).toBe(42);
    expect(body.ticket_title).toBe("Test ticket");
    expect(body.base_branch).toBeUndefined();
  });

  it("on create success onRefresh is called", async () => {
    const ticket = makeTicket({ id: "42", project_id: "proj-a", project_path: "/repos/alpha" });
    const { presenter } = makePresenter();
    const fetchJson = vi.fn().mockResolvedValue({ ok: true, status: 201, data: {} });
    const client: TicketsClient = { fetchJson, onBackendCrashed: vi.fn() };
    const onRefresh = vi.fn();

    const { container } = render(
      <TicketCard ticket={ticket} presenter={presenter} client={client} onRefresh={onRefresh} isActive={false} />
    );

    const btn = container.querySelector(".card-worktree-btn") as HTMLElement;
    await userEvent.click(btn);

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("non-ok create response renders error text", async () => {
    const ticket = makeTicket({ id: "42", project_id: "proj-a", project_path: "/repos/alpha" });
    const { presenter } = makePresenter();
    const fetchJson = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      data: { detail: "Duplicate worktree" },
    });
    const client: TicketsClient = { fetchJson, onBackendCrashed: vi.fn() };
    const onRefresh = vi.fn();

    const { container } = render(
      <TicketCard ticket={ticket} presenter={presenter} client={client} onRefresh={onRefresh} isActive={false} />
    );

    const btn = container.querySelector(".card-worktree-btn") as HTMLElement;
    await userEvent.click(btn);

    const errorEl = container.querySelector(".card-worktree-error");
    expect(errorEl).not.toBeNull();
    expect(errorEl!.textContent).toContain("Duplicate worktree");
    expect(onRefresh).not.toHaveBeenCalled();
  });
});

describe("TicketCard — delete worktree", () => {
  it("clicking 'Worktree löschen' calls fetchJson with method DELETE", async () => {
    const ticket = makeTicketWithWorktree("workboard-fix-42-abcd1234");
    const { presenter } = makePresenter();
    const fetchJson = vi.fn().mockResolvedValue({ ok: true, status: 200, data: { id: "workboard-fix-42-abcd1234", status: "removed" } });
    const client: TicketsClient = { fetchJson, onBackendCrashed: vi.fn() };
    const onRefresh = vi.fn();

    const { container } = render(
      <TicketCard ticket={ticket} presenter={presenter} client={client} onRefresh={onRefresh} isActive={false} />
    );

    const btn = container.querySelector(".card-worktree-btn--delete") as HTMLElement;
    expect(btn).not.toBeNull();
    await userEvent.click(btn);

    expect(fetchJson).toHaveBeenCalledWith(
      expect.stringContaining("/worktrees/workboard-fix-42-abcd1234"),
      expect.objectContaining({ method: "DELETE" })
    );
  });

  it("on delete success onRefresh is called", async () => {
    const ticket = makeTicketWithWorktree();
    const { presenter } = makePresenter();
    const fetchJson = vi.fn().mockResolvedValue({ ok: true, status: 200, data: {} });
    const client: TicketsClient = { fetchJson, onBackendCrashed: vi.fn() };
    const onRefresh = vi.fn();

    const { container } = render(
      <TicketCard ticket={ticket} presenter={presenter} client={client} onRefresh={onRefresh} isActive={false} />
    );

    const btn = container.querySelector(".card-worktree-btn--delete") as HTMLElement;
    await userEvent.click(btn);

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("non-ok delete response renders error text and onRefresh is NOT called", async () => {
    const ticket = makeTicketWithWorktree();
    const { presenter } = makePresenter();
    const fetchJson = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      data: { detail: "Worktree directory is locked" },
    });
    const client: TicketsClient = { fetchJson, onBackendCrashed: vi.fn() };
    const onRefresh = vi.fn();

    const { container } = render(
      <TicketCard ticket={ticket} presenter={presenter} client={client} onRefresh={onRefresh} isActive={false} />
    );

    const btn = container.querySelector(".card-worktree-btn--delete") as HTMLElement;
    await userEvent.click(btn);

    const errorEl = container.querySelector(".card-worktree-error");
    expect(errorEl).not.toBeNull();
    expect(errorEl!.textContent).toContain("Worktree directory is locked");
    expect(onRefresh).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// TicketCard — worktree highlight (ticket #59)
// ---------------------------------------------------------------------------

describe("TicketCard — worktree highlight", () => {
  it("ticket with worktree != null gets class ticket-card--has-worktree", () => {
    const ticket = makeTicketWithWorktree();
    const { presenter } = makePresenter();
    const { container } = render(
      <TicketCard ticket={ticket} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} isActive={false} />
    );
    const card = container.querySelector(".ticket-card");
    expect(card).not.toBeNull();
    expect(card!.classList.contains("ticket-card--has-worktree")).toBe(true);
  });

  it("ticket with worktree: null does NOT get class ticket-card--has-worktree", () => {
    const ticket = makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" });
    const { presenter } = makePresenter();
    const { container } = render(
      <TicketCard ticket={ticket} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} isActive={false} />
    );
    const card = container.querySelector(".ticket-card");
    expect(card!.classList.contains("ticket-card--has-worktree")).toBe(false);
  });

  it("ticket with both PR and worktree carries both modifier classes", () => {
    const ticket = makeTicket({
      id: "5",
      project_id: "proj-a",
      project_path: "/repos/alpha",
      pull_request: { number: 5, url: "https://github.com/x/y/pull/5", status: "open", draft: false },
      worktree: { id: "wt-5", path: "/wt/5", branch: "fix/5-test", status: "idle" },
    });
    const { presenter } = makePresenter();
    const { container } = render(
      <TicketCard ticket={ticket} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} isActive={false} />
    );
    const card = container.querySelector(".ticket-card");
    expect(card!.classList.contains("ticket-card--has-pr")).toBe(true);
    expect(card!.classList.contains("ticket-card--has-worktree")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TicketCard — active border (ticket #59)
// ---------------------------------------------------------------------------

describe("TicketCard — active border", () => {
  it("isActive=true adds class ticket-card--active", () => {
    const ticket = makeTicket({ id: "3", project_id: "proj-a", project_path: "/repos/alpha" });
    const { presenter } = makePresenter();
    const { container } = render(
      <TicketCard ticket={ticket} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} isActive={true} />
    );
    const card = container.querySelector(".ticket-card");
    expect(card!.classList.contains("ticket-card--active")).toBe(true);
  });

  it("isActive=false does NOT add class ticket-card--active", () => {
    const ticket = makeTicket({ id: "3", project_id: "proj-a", project_path: "/repos/alpha" });
    const { presenter } = makePresenter();
    const { container } = render(
      <TicketCard ticket={ticket} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} isActive={false} />
    );
    const card = container.querySelector(".ticket-card");
    expect(card!.classList.contains("ticket-card--active")).toBe(false);
  });

  it("only the card whose id matches activeTicketId gets ticket-card--active", () => {
    const tickets = [
      makeTicket({ id: "10", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "20", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "30", project_id: "proj-a", project_path: "/repos/alpha" }),
    ];
    const { presenter } = makePresenter();
    const { container } = render(
      <TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} activeTicketId="20" />
    );
    const cards = container.querySelectorAll(".ticket-card");
    expect(cards[0].classList.contains("ticket-card--active")).toBe(false);
    expect(cards[1].classList.contains("ticket-card--active")).toBe(true);
    expect(cards[2].classList.contains("ticket-card--active")).toBe(false);
  });

  it("activeTicketId=null: no card gets ticket-card--active", () => {
    const tickets = [
      makeTicket({ id: "10", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "20", project_id: "proj-a", project_path: "/repos/alpha" }),
    ];
    const { presenter } = makePresenter();
    const { container } = render(
      <TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} activeTicketId={null} />
    );
    const cards = container.querySelectorAll(".ticket-card");
    for (const card of Array.from(cards)) {
      expect(card.classList.contains("ticket-card--active")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// TicketCard — label chips removed (ticket #69)
// Labels are no longer shown on the card; they appear on the detail view.
// ---------------------------------------------------------------------------

describe("TicketCard — label chips", () => {
  it("does NOT render .card-labels container even when ticket has labels", () => {
    const ticket = makeTicket({
      id: "1",
      project_id: "proj-a",
      project_path: "/repos/alpha",
      labels: ["bug", "urgent"],
    });
    const { presenter } = makePresenter();
    const { container } = render(
      <TicketCard ticket={ticket} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} isActive={false} />
    );
    const labelsEl = container.querySelector(".card-labels");
    expect(labelsEl).toBeNull();
  });

  it("does NOT render any .card-label-chip elements", () => {
    const ticket = makeTicket({
      id: "1",
      project_id: "proj-a",
      project_path: "/repos/alpha",
      labels: ["bug", "urgent", "feature"],
    });
    const { presenter } = makePresenter();
    const { container } = render(
      <TicketCard ticket={ticket} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} isActive={false} />
    );
    const chips = container.querySelectorAll(".card-label-chip");
    expect(chips).toHaveLength(0);
  });

  it("does NOT render .card-labels when ticket has no labels (empty array)", () => {
    const ticket = makeTicket({
      id: "1",
      project_id: "proj-a",
      project_path: "/repos/alpha",
      labels: [],
    });
    const { presenter } = makePresenter();
    const { container } = render(
      <TicketCard ticket={ticket} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} isActive={false} />
    );
    const labelsEl = container.querySelector(".card-labels");
    expect(labelsEl).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TicketList — collapsible project groups (ticket #83)
// ---------------------------------------------------------------------------

describe("TicketList — collapsible groups", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("click-to-collapse: clicking a header adds the collapsed modifier class and removes cards", async () => {
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "2", project_id: "proj-a", project_path: "/repos/alpha" }),
    ];
    const { presenter } = makePresenter();
    const { container } = render(
      <TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} activeTicketId={null} />
    );

    const header = container.querySelector(".project-group-header") as HTMLElement;
    expect(header).not.toBeNull();
    // Before: not collapsed, cards visible
    expect(header.classList.contains("project-group-header--collapsed")).toBe(false);
    expect(container.querySelectorAll(".ticket-card")).toHaveLength(2);

    await userEvent.click(header);

    // After: header has collapsed modifier, cards gone
    expect(header.classList.contains("project-group-header--collapsed")).toBe(true);
    expect(container.querySelectorAll(".ticket-card")).toHaveLength(0);
  });

  it("click-to-expand: clicking a collapsed header removes the modifier class and restores cards", async () => {
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "2", project_id: "proj-a", project_path: "/repos/alpha" }),
    ];
    const { presenter } = makePresenter();
    const { container } = render(
      <TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} activeTicketId={null} />
    );

    const header = container.querySelector(".project-group-header") as HTMLElement;
    // Collapse first
    await userEvent.click(header);
    expect(header.classList.contains("project-group-header--collapsed")).toBe(true);
    expect(container.querySelectorAll(".ticket-card")).toHaveLength(0);

    // Now expand
    await userEvent.click(header);
    expect(header.classList.contains("project-group-header--collapsed")).toBe(false);
    expect(container.querySelectorAll(".ticket-card")).toHaveLength(2);
  });

  it("only clicked group collapses: collapsing one group does not affect sibling groups", async () => {
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "2", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "3", project_id: "proj-b", project_path: "/repos/beta" }),
      makeTicket({ id: "4", project_id: "proj-b", project_path: "/repos/beta" }),
    ];
    const { presenter } = makePresenter();
    const { container } = render(
      <TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} activeTicketId={null} />
    );

    const headers = container.querySelectorAll(".project-group-header") as NodeListOf<HTMLElement>;
    expect(headers).toHaveLength(2);

    // Collapse only the first group
    await userEvent.click(headers[0]);

    // First group should be collapsed
    expect(headers[0].classList.contains("project-group-header--collapsed")).toBe(true);
    // Second group should remain expanded
    expect(headers[1].classList.contains("project-group-header--collapsed")).toBe(false);

    // Cards from proj-b should still be visible (2 cards)
    const cards = container.querySelectorAll(".ticket-card");
    expect(cards).toHaveLength(2);
  });

  it("localStorage write on toggle: clicking a header calls localStorage.setItem with collapsed-projects key", async () => {
    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" }),
    ];
    const { presenter } = makePresenter();
    // Spy on the Storage prototype so all localStorage instances in this jsdom environment are covered.
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

    const { container } = render(
      <TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} activeTicketId={null} />
    );

    const header = container.querySelector(".project-group-header") as HTMLElement;
    await userEvent.click(header);

    expect(setItemSpy).toHaveBeenCalledWith(
      "collapsed-projects",
      JSON.stringify(["proj-a"])
    );

    setItemSpy.mockRestore();
  });

  it("initialise from localStorage: pre-seeding localStorage causes group to start collapsed", () => {
    localStorage.setItem("collapsed-projects", JSON.stringify(["proj-a"]));

    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "2", project_id: "proj-a", project_path: "/repos/alpha" }),
    ];
    const { presenter } = makePresenter();
    const { container } = render(
      <TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} activeTicketId={null} />
    );

    const header = container.querySelector(".project-group-header") as HTMLElement;
    // Group should already be collapsed on first render
    expect(header.classList.contains("project-group-header--collapsed")).toBe(true);
    // No ticket cards should be rendered
    expect(container.querySelectorAll(".ticket-card")).toHaveLength(0);
  });

  it("corrupt localStorage fallback: non-JSON value causes component to mount without throwing and defaults to expanded", () => {
    localStorage.setItem("collapsed-projects", "not-valid-json{{{");

    const tickets = [
      makeTicket({ id: "1", project_id: "proj-a", project_path: "/repos/alpha" }),
    ];
    const { presenter } = makePresenter();

    expect(() => {
      const { container } = render(
        <TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} activeTicketId={null} />
      );
      // Should default to expanded — no collapsed modifier on any header
      const headers = container.querySelectorAll(".project-group-header");
      expect(headers).toHaveLength(1);
      expect(headers[0].classList.contains("project-group-header--collapsed")).toBe(false);
      // Cards should be visible
      expect(container.querySelectorAll(".ticket-card")).toHaveLength(1);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// TicketList — duplicate ticket ids across projects (ticket #79 regression)
// ---------------------------------------------------------------------------

describe("TicketList — duplicate ids across different projects", () => {
  it("two tickets with the same numeric id but different project_id both render as distinct cards", () => {
    // Regression for ticket #79: ticket #11 from Seretos/obsidian-memory-gatekeeper
    // was appearing 5 times because React's key={ticket.id} silently deduplicated
    // cards when the same numeric id appeared for multiple projects.
    const tickets = [
      makeTicket({ id: "11", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "11", project_id: "proj-b", project_path: "/repos/beta" }),
    ];
    const { presenter } = makePresenter();
    const { container } = render(
      <TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} activeTicketId={null} />
    );

    // Both cards must appear — neither is silently dropped by React key dedup.
    const cards = container.querySelectorAll(".ticket-card");
    expect(cards).toHaveLength(2);
  });

  it("five tickets with the same numeric id across five different projects all render", () => {
    // Mirrors the reported symptom: ticket #11 shown 5x means 5 projects each
    // have a ticket #11, but without compound keys only one card would render.
    const tickets = [
      makeTicket({ id: "11", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "11", project_id: "proj-b", project_path: "/repos/beta" }),
      makeTicket({ id: "11", project_id: "proj-c", project_path: "/repos/gamma" }),
      makeTicket({ id: "11", project_id: "proj-d", project_path: "/repos/delta" }),
      makeTicket({ id: "11", project_id: "proj-e", project_path: "/repos/epsilon" }),
    ];
    const { presenter } = makePresenter();
    const { container } = render(
      <TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} activeTicketId={null} />
    );

    const cards = container.querySelectorAll(".ticket-card");
    expect(cards).toHaveLength(5);
  });

  it("tickets with the same id across projects each appear under the correct project header", () => {
    const tickets = [
      makeTicket({ id: "11", project_id: "proj-a", project_path: "/repos/alpha" }),
      makeTicket({ id: "11", project_id: "proj-b", project_path: "/repos/beta" }),
    ];
    const { presenter } = makePresenter();
    const { container } = render(
      <TicketList tickets={tickets} presenter={presenter} client={makeClient()} onRefresh={vi.fn()} activeTicketId={null} />
    );

    // Two separate project groups should be present.
    const headers = container.querySelectorAll(".project-group-header");
    expect(headers).toHaveLength(2);
    expect(headers[0].textContent).toContain("/repos/alpha");
    expect(headers[1].textContent).toContain("/repos/beta");
  });
});

// ---------------------------------------------------------------------------
// BrowserDetailPresenter — close() (ticket #91 regression)
// ---------------------------------------------------------------------------

describe("BrowserDetailPresenter — close()", () => {
  it("close() clears activeId to null", () => {
    const setter = vi.fn();
    const onActiveIdChange = vi.fn();
    const presenter = new BrowserDetailPresenter(setter, onActiveIdChange);

    const ticket: DetailTicket = { id: "10", title: "T", status: "open", url: "https://x.com", labels: [], provider: "github", project_id: "p", project_path: "/r", pull_request: null, body: undefined };
    presenter.open(ticket);
    expect(presenter.getActiveId()).toBe("10");

    presenter.close();
    expect(presenter.getActiveId()).toBeNull();
  });

  it("close() calls onActiveIdChange(null)", () => {
    const setter = vi.fn();
    const onActiveIdChange = vi.fn();
    const presenter = new BrowserDetailPresenter(setter, onActiveIdChange);

    const ticket: DetailTicket = { id: "10", title: "T", status: "open", url: "https://x.com", labels: [], provider: "github", project_id: "p", project_path: "/r", pull_request: null, body: undefined };
    presenter.open(ticket);
    onActiveIdChange.mockClear();

    presenter.close();
    expect(onActiveIdChange).toHaveBeenCalledOnce();
    expect(onActiveIdChange).toHaveBeenCalledWith(null);
  });

  it("close() calls setter(null) to dismiss the modal", () => {
    const setter = vi.fn();
    const onActiveIdChange = vi.fn();
    const presenter = new BrowserDetailPresenter(setter, onActiveIdChange);

    const ticket: DetailTicket = { id: "10", title: "T", status: "open", url: "https://x.com", labels: [], provider: "github", project_id: "p", project_path: "/r", pull_request: null, body: undefined };
    presenter.open(ticket);
    setter.mockClear();

    presenter.close();
    expect(setter).toHaveBeenCalledOnce();
    expect(setter).toHaveBeenCalledWith(null);
  });
});

// ---------------------------------------------------------------------------
// ElectronDetailPresenter — close() (ticket #91 regression)
// ---------------------------------------------------------------------------

describe("ElectronDetailPresenter — close()", () => {
  it("close() clears activeId to null", () => {
    // Provide a minimal stub for window.detail so the constructor / open() does not throw.
    (window as unknown as { detail: { openTicketDetail: ReturnType<typeof vi.fn> } }).detail = { openTicketDetail: vi.fn() };

    const onActiveIdChange = vi.fn();
    const presenter = new ElectronDetailPresenter(onActiveIdChange);

    const ticket: DetailTicket = { id: "20", title: "T", status: "open", url: "https://x.com", labels: [], provider: "github", project_id: "p", project_path: "/r", pull_request: null, body: undefined };
    presenter.open(ticket);
    expect(presenter.getActiveId()).toBe("20");

    presenter.close();
    expect(presenter.getActiveId()).toBeNull();
  });

  it("close() calls onActiveIdChange(null)", () => {
    (window as unknown as { detail: { openTicketDetail: ReturnType<typeof vi.fn> } }).detail = { openTicketDetail: vi.fn() };

    const onActiveIdChange = vi.fn();
    const presenter = new ElectronDetailPresenter(onActiveIdChange);

    const ticket: DetailTicket = { id: "20", title: "T", status: "open", url: "https://x.com", labels: [], provider: "github", project_id: "p", project_path: "/r", pull_request: null, body: undefined };
    presenter.open(ticket);
    onActiveIdChange.mockClear();

    presenter.close();
    expect(onActiveIdChange).toHaveBeenCalledOnce();
    expect(onActiveIdChange).toHaveBeenCalledWith(null);
  });

  it("close() calls hideTicketDetail when available", () => {
    const hideTicketDetail = vi.fn();
    (window as unknown as {
      detail: { openTicketDetail: ReturnType<typeof vi.fn>; hideTicketDetail: ReturnType<typeof vi.fn> };
    }).detail = { openTicketDetail: vi.fn(), hideTicketDetail };

    const presenter = new ElectronDetailPresenter(vi.fn());
    const ticket: DetailTicket = { id: "20", title: "T", status: "open", url: "https://x.com", labels: [], provider: "github", project_id: "p", project_path: "/r", pull_request: null, body: undefined };
    presenter.open(ticket);

    presenter.close();
    expect(hideTicketDetail).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// ElectronDetailPresenter — onDetailClosed (ticket #93)
// ---------------------------------------------------------------------------

describe("ElectronDetailPresenter — onDetailClosed", () => {
  it("onDetailClosed callback clears activeId", () => {
    let capturedCallback: (() => void) | undefined;
    (window as unknown as {
      detail: {
        openTicketDetail: ReturnType<typeof vi.fn>;
        onDetailClosed: (cb: () => void) => void;
      };
    }).detail = {
      openTicketDetail: vi.fn(),
      onDetailClosed: (cb: () => void) => { capturedCallback = cb; },
    };

    const onActiveIdChange = vi.fn();
    const presenter = new ElectronDetailPresenter(onActiveIdChange);

    const ticket: DetailTicket = { id: "30", title: "T", status: "open", url: "https://x.com", labels: [], provider: "github", project_id: "p", project_path: "/r", pull_request: null, body: undefined };
    presenter.open(ticket);
    expect(presenter.getActiveId()).toBe("30");

    // Simulate main process broadcasting "detail-closed" (Alt+F4, tray hide)
    expect(capturedCallback).toBeDefined();
    capturedCallback!();

    expect(presenter.getActiveId()).toBeNull();
  });

  it("onDetailClosed callback calls onActiveIdChange(null)", () => {
    let capturedCallback: (() => void) | undefined;
    (window as unknown as {
      detail: {
        openTicketDetail: ReturnType<typeof vi.fn>;
        onDetailClosed: (cb: () => void) => void;
      };
    }).detail = {
      openTicketDetail: vi.fn(),
      onDetailClosed: (cb: () => void) => { capturedCallback = cb; },
    };

    const onActiveIdChange = vi.fn();
    const presenter = new ElectronDetailPresenter(onActiveIdChange);

    const ticket: DetailTicket = { id: "30", title: "T", status: "open", url: "https://x.com", labels: [], provider: "github", project_id: "p", project_path: "/r", pull_request: null, body: undefined };
    presenter.open(ticket);
    onActiveIdChange.mockClear();

    capturedCallback!();

    expect(onActiveIdChange).toHaveBeenCalledOnce();
    expect(onActiveIdChange).toHaveBeenCalledWith(null);
  });
});
