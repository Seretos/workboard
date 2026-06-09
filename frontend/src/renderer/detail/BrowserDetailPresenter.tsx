import type { DetailPresenter } from "./DetailPresenter";
import type { DetailTicket } from "../types";

export class BrowserDetailPresenter implements DetailPresenter {
  private setter: (t: DetailTicket | null) => void;

  constructor(setter: (t: DetailTicket | null) => void) {
    this.setter = setter;
  }

  open(ticket: DetailTicket): void {
    this.setter(ticket);
  }
}
