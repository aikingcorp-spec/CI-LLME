const params = new URLSearchParams(location.search);
document.documentElement.lang = params.get("locale") === "en" ? "en" : "vi";
const hint = document.querySelector(".hint");
const contact = document.querySelector("a");
contact.textContent = params.get("contact");
setTimeout(() => {
  hint.textContent = `${params.get("slow")}\n${params.get("starting")}`;
  hint.hidden = false;
}, 10_000);
setTimeout(() => {
  hint.textContent = params.get("failed");
  hint.hidden = false;
  contact.hidden = false;
}, 60_000);
