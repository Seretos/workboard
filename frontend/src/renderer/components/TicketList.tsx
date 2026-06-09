import React from "react";
import type { TicketRow } from "../types";
import type { DetailPresenter } from "../detail/DetailPresenter";
import { TicketCard } from "./TicketCard";

interface Props {
  tickets: TicketRow[];
  presenter: DetailPresenter;
}

export function TicketList({ tickets, presenter }: Props): React.ReactElement {
  // Group tickets by project_id, preserving insertion order.
  const groups = new Map<string, TicketRow[]>();
  for (const ticket of tickets) {
    const key = ticket.project_id ?? "";
    const existing = groups.get(key);
    if (existing) {
      existing.push(ticket);
    } else {
      groups.set(key, [ticket]);
    }
  }

  const items: React.ReactElement[] = [];
  for (const [, groupTickets] of groups) {
    const projectPath = groupTickets[0].project_path ?? "";
    items.push(
      <li key={`header-${groupTickets[0].project_id}`} className="project-group-header">
        <span className="group-label">{projectPath}</span>
        <span className="group-count">{String(groupTickets.length)}</span>
      </li>
    );
    for (const ticket of groupTickets) {
      items.push(
        <TicketCard
          key={ticket.id}
          ticket={ticket}
          presenter={presenter}
        />
      );
    }
  }

  return <ul id="ticket-list">{items}</ul>;
}
