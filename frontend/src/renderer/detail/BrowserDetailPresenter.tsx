import type { DetailPresenter } from "./DetailPresenter";
import type { DetailTicket } from "../types";

export class BrowserDetailPresenter implements DetailPresenter {
  private setter: (t: DetailTicket | null) => void;
  private onActiveIdChange: (id: string | null) => void;
  private activeId: string | null = null;

  constructor(
    setter: (t: DetailTicket | null) => void,
    onActiveIdChange: (id: string | null) => void = () => {},
  ) {
    this.setter = setter;
    this.onActiveIdChange = onActiveIdChange;
  }

  open(ticket: DetailTicket): void {
    this.setter(ticket);
    const id = ticket.id ?? null;
    this.activeId = id;
    this.onActiveIdChange(id);
  }

  getActiveId(): string | null {
    return this.activeId;
  }
}
