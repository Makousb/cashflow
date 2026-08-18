// Auto-dismiss flash messages after a few seconds.
document.querySelectorAll(".flash-success, .flash-error").forEach((flash) => {
  setTimeout(() => {
    flash.style.transition = "opacity 0.4s ease";
    flash.style.opacity = "0";
    setTimeout(() => flash.remove(), 400);
  }, 4000);
});

// The mobile sidebar toggle (see .sidebar / .mobile-topbar in main.css).
// Only present when logged in, so both elements are absent on the public
// pages — this whole block is a no-op there rather than an error.
(function () {
  const toggle = document.querySelector(".nav-toggle");
  const nav = document.getElementById("app-sidebar");
  const backdrop = document.getElementById("sidebar-backdrop");
  if (!toggle || !nav) return;

  function close() {
    nav.classList.remove("is-open");
    backdrop?.classList.remove("is-open");
    toggle.setAttribute("aria-expanded", "false");
  }
  function open() {
    nav.classList.add("is-open");
    backdrop?.classList.add("is-open");
    toggle.setAttribute("aria-expanded", "true");
  }

  toggle.addEventListener("click", () => {
    nav.classList.contains("is-open") ? close() : open();
  });

  // Following a link is the point of opening it — leave it open and the next
  // page loads behind a drawer still covering it.
  nav.addEventListener("click", (event) => {
    if (event.target.closest("a")) close();
  });

  backdrop?.addEventListener("click", close);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  document.addEventListener("click", (event) => {
    if (
      nav.classList.contains("is-open") &&
      !nav.contains(event.target) &&
      !toggle.contains(event.target)
    ) {
      close();
    }
  });
})();
