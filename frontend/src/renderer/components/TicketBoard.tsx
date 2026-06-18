import React from "react";
import type { TicketRow } from "../types";
import type { DetailPresenter } from "../detail/DetailPresenter";
import type { TicketsClient } from "../client/TicketsClient";
import { TicketList } from "./TicketList";
import { StatusBar } from "./StatusBar";

interface Props {
  tickets: TicketRow[];
  status: string;
  ticketCount: string;
  presenter: DetailPresenter;
  client: TicketsClient;
  onRefresh: () => void;
  activeTicketId: string | null;
}

export function TicketBoard({ tickets, status, ticketCount, presenter, client, onRefresh, activeTicketId }: Props): React.ReactElement {
  return (
    <>
      <header className="panel-header">
        <span className="panel-title">workboard</span>
        <span id="ticket-count" className="ticket-count">{ticketCount}</span>
      </header>
      <TicketList tickets={tickets} presenter={presenter} client={client} onRefresh={onRefresh} activeTicketId={activeTicketId} />
      <StatusBar status={status} />
    </>
  );
}
