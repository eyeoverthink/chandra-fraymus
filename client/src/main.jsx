// Vite development compatibility only. Production serves MyAIPartner directly;
// /partner/ is proxied to that same application while using Chandra's dev port.
const target = new URL('/partner/', window.location.origin);
target.search = window.location.search;
target.hash = window.location.hash;
window.location.replace(target.href);
