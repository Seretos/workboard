import React from "react";
import type { DetailTicket } from "../types";
import { DetailView } from "../detail/DetailView";

interface Props {
  ticket: DetailTicket | null;
  onClose: () => void;
}

export function DetailModal({ ticket, onClose }: Props): React.ReactElement | null {
  if (!ticket) return null;

  return (
    <div className="detail-modal-overlay">
      <div className="detail-modal-container">
        <button
          className="detail-modal-close"
          type="button"
          onClick={onClose}
          aria-label="Close"
        >
          &#x2715;
        </button>
        <DetailView ticket={ticket} onClose={onClose} />
      </div>
    </div>
  );
}
