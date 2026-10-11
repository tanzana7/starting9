// This is an explicit presentation window, independent of competition state.
// Keeping it here gives user and admin shells the same Tokyo-time boundaries
// while allowing their navigation policies to remain intentionally different.
window.STARTING9_EDITION_WINDOW = Object.freeze({
  activeFrom: "2026-11-10T00:00:00+09:00",
  activeUntil: "2026-12-01T00:00:00+09:00",
  timeZone: "Asia/Tokyo"
});
