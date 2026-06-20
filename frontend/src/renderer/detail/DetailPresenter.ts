import type { DetailTicket } from "../types";

export interface DetailPresenter {
  open(ticket: DetailTicket): void;
  close(): void;
  getActiveId(): string | null;
}
