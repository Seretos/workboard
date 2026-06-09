import React from "react";

interface Props {
  status: string;
}

export function StatusBar({ status }: Props): React.ReactElement {
  return <footer className="status-bar">{status}</footer>;
}
