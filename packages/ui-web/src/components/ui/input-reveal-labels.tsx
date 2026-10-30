import * as React from "react";

/** The labels of the show/hide button on hidden fields; the kit itself is not translated. */
const RevealLabelsContext = React.createContext({ show: "Show password", hide: "Hide password" });

/** Supplies translated labels for the show/hide button of every hidden field below it. */
function InputRevealLabelsProvider({
  show,
  hide,
  children,
}: {
  show: string;
  hide: string;
  children: React.ReactNode;
}) {
  const labels = React.useMemo(() => ({ show, hide }), [show, hide]);
  return <RevealLabelsContext.Provider value={labels}>{children}</RevealLabelsContext.Provider>;
}

export { InputRevealLabelsProvider, RevealLabelsContext };
