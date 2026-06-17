import React from "react";
import type { TicketsClient } from "../client/TicketsClient";
import type { DetailPresenter } from "../detail/DetailPresenter";
import { useTicketPolling } from "../hooks/useTicketPolling";
import { TicketBoard } from "./TicketBoard";

interface Props {
  client: TicketsClient;
  presenter: DetailPresenter;
}

export function App({ client, presenter }: Props): React.ReactElement {
  const { tickets, status, ticketCount, refresh } = useTicketPolling(client);

  return (
    <TicketBoard
      tickets={tickets}
      status={status}
      ticketCount={ticketCount}
      presenter={presenter}
      client={client}
      onRefresh={refresh}
    />
  );
}
