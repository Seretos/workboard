import type { DetailTicket } from "../types";

export interface DetailPresenter {
  open(ticket: DetailTicket): void;
}
