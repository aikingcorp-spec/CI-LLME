import { useEffect, useState } from "react";

/** The theme already applied on `<html data-theme>`. Defaults to dark, matching the shell. */
export function useResolvedAppearance(): "light" | "dark" {
  const [appearance, setAppearance] = useState<"light" | "dark">(() =>
    typeof document !== "undefined" && document.documentElement.dataset.theme === "light"
      ? "light"
      : "dark",
  );
  useEffect(() => {
    const root = document.documentElement;
    const read = () => setAppearance(root.dataset.theme === "light" ? "light" : "dark");
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return appearance;
}
