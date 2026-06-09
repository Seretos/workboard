import type { DetailPresenter } from "./DetailPresenter";
import type { DetailTicket } from "../types";

export class ElectronDetailPresenter implements DetailPresenter {
  open(ticket: DetailTicket): void {
    window.detail.openTicketDetail(ticket);
  }
}
