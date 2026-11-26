const status = document.querySelector("[data-copy-status]");

function announce(message) {
  if (status) status.textContent = message;
}

async function copyFrom(button) {
  const source = document.getElementById(button.dataset.copyFrom);
  if (!source) return;
  const label = button.querySelector("[data-copy-text]");
  try {
    await navigator.clipboard.writeText(source.textContent.trim());
    if (label) label.textContent = "Copied";
    announce("Copied to the clipboard");
  } catch {
    announce("Copy failed. Select the text and copy it by hand.");
    return;
  }
  setTimeout(() => {
    if (label) label.textContent = "Copy";
  }, 1600);
}

if (navigator.clipboard) {
  for (const button of document.querySelectorAll("[data-copy-from]")) {
    button.hidden = false;
    button.addEventListener("click", () => copyFrom(button));
  }
}

const hostButtons = [...document.querySelectorAll("[data-host]")];
const hostLabel = document.querySelector("[data-host-label]");

for (const button of hostButtons) {
  button.addEventListener("click", () => {
    for (const other of hostButtons) other.setAttribute("aria-pressed", String(other === button));
    if (hostLabel) hostLabel.textContent = button.dataset.host;
  });
}

const chapterLinks = [...document.querySelectorAll("[data-chapter-link]")];

if (chapterLinks.length > 0 && "IntersectionObserver" in window) {
  const byId = new Map(chapterLinks.map((link) => [link.hash.slice(1), link]));
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      for (const link of chapterLinks) link.removeAttribute("aria-current");
      byId.get(entry.target.id)?.setAttribute("aria-current", "true");
    }
  }, { rootMargin: "0px 0px -70% 0px" });
  for (const id of byId.keys()) {
    const chapter = document.getElementById(id);
    if (chapter) observer.observe(chapter);
  }
}
