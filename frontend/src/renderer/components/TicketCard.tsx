import React, { useState } from "react";
import type { TicketRow } from "../types";
import type { DetailPresenter } from "../detail/DetailPresenter";
import type { TicketsClient } from "../client/TicketsClient";

interface Props {
  ticket: TicketRow;
  presenter: DetailPresenter;
  client: TicketsClient;
  onRefresh: () => void;
}

export function TicketCard({ ticket, presenter, client, onRefresh }: Props): React.ReactElement {
  const [isCreating, setIsCreating] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [worktreeError, setWorktreeError] = useState<string | null>(null);
  const [forceDelete, setForceDelete] = useState(false);

  const className =
    ticket.pull_request != null
      ? "ticket-card ticket-card--has-pr"
      : "ticket-card";

  const handleClick = () => {
    presenter.open(ticket);
  };

  const handleCreateWorktree = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsCreating(true);
    setWorktreeError(null);
    try {
      const response = await client.fetchJson("/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          project_id: ticket.project_id,
          ticket_number: parseInt(ticket.id, 10) || 0,
          ticket_title: ticket.title,
          base_branch: "main",
        }),
      });
      if (!response.ok) {
        const detail = (response.data as { detail?: string } | null)?.detail;
        setWorktreeError(detail ?? `Fehler: HTTP ${response.status}`);
      } else {
        setWorktreeError(null);
        onRefresh();
      }
    } catch (err) {
      setWorktreeError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsCreating(false);
    }
  };

  const handleDeleteWorktree = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (ticket.worktree == null) return;
    setIsDeleting(true);
    setWorktreeError(null);
    try {
      const response = await client.fetchJson(
        `/worktrees/${ticket.worktree.id}?force=${forceDelete}`,
        { method: "DELETE" }
      );
      if (!response.ok) {
        const detail = (response.data as { detail?: string } | null)?.detail;
        setWorktreeError(detail ?? `Fehler: HTTP ${response.status}`);
      } else {
        setWorktreeError(null);
        setForceDelete(false);
        onRefresh();
      }
    } catch (err) {
      setWorktreeError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsDeleting(false);
    }
  };

  const metaParts = [ticket.project_path, ticket.status].filter(Boolean);

  return (
    <li className={className} onClick={handleClick}>
      <div className="card-head">
        <span className="card-provider">{ticket.provider ?? ""}</span>
        <span className="card-id">{ticket.id ? `#${ticket.id}` : ""}</span>
        {ticket.worktree != null && (
          <span className="card-worktree-badge" title={ticket.worktree.branch}>
            worktree
          </span>
        )}
      </div>
      <div className="card-title">{ticket.title ?? ""}</div>
      <div className="card-meta">{metaParts.join(" · ")}</div>
      {ticket.worktree == null ? (
        <button
          className="card-worktree-btn"
          disabled={isCreating}
          onClick={handleCreateWorktree}
        >
          {isCreating ? "Erstelle…" : "Worktree erstellen"}
        </button>
      ) : (
        <div className="card-worktree-delete">
          <button
            className="card-worktree-btn card-worktree-btn--delete"
            disabled={isDeleting}
            onClick={handleDeleteWorktree}
          >
            {isDeleting ? "Lösche…" : "Worktree löschen"}
          </button>
          <label className="card-force-delete" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={forceDelete}
              onChange={(e) => setForceDelete(e.target.checked)}
              onClick={(e) => e.stopPropagation()}
            />
            {" "}Mit force löschen
          </label>
        </div>
      )}
      {worktreeError != null && (
        <div className="card-worktree-error">{worktreeError}</div>
      )}
    </li>
  );
}
