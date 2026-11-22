// Reveal sections as they come into view. If the observer is unavailable,
// everything is simply visible.
(() => {
  const items = document.querySelectorAll("[data-rise]");
  if (!("IntersectionObserver" in window) || !items.length) {
    items.forEach((el) => el.classList.add("in"));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          io.unobserve(entry.target);
        }
      }
    },
    { rootMargin: "0px 0px -5% 0px", threshold: 0 },
  );
  items.forEach((el) => io.observe(el));
})();
