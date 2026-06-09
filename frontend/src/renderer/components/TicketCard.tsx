import React from "react";
import type { TicketRow } from "../types";
import type { DetailPresenter } from "../detail/DetailPresenter";

interface Props {
  ticket: TicketRow;
  presenter: DetailPresenter;
}

export function TicketCard({ ticket, presenter }: Props): React.ReactElement {
  const className =
    ticket.pull_request != null
      ? "ticket-card ticket-card--has-pr"
      : "ticket-card";

  const handleClick = () => {
    presenter.open(ticket);
  };

  const metaParts = [ticket.project_path, ticket.status].filter(Boolean);

  return (
    <li className={className} onClick={handleClick}>
      <div className="card-head">
        <span className="card-provider">{ticket.provider ?? ""}</span>
        <span className="card-id">{ticket.id ? `#${ticket.id}` : ""}</span>
      </div>
      <div className="card-title">{ticket.title ?? ""}</div>
      <div className="card-meta">{metaParts.join(" · ")}</div>
    </li>
  );
}
