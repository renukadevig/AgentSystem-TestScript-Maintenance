/**
 * Products selectable in the UI dropdown.
 *
 * Each product maps to a base URL the Cypress run targets (CYPRESS_BASE_URL)
 * and an optional spec-path glob so a single repo serving many products can be
 * filtered down. Edit this list for your org — it is the only product-specific
 * knowledge in the app.
 */
export const PRODUCTS = [
  {
    id: "almosafer-web",
    name: "Almosafer — Web",
    baseUrl: "https://www.almosafer.com",
    // only run specs under these paths (empty = all discovered specs)
    specGlobs: [],
  },
  {
    id: "almosafer-flights",
    name: "Almosafer — Flights",
    baseUrl: "https://www.almosafer.com/flights",
    specGlobs: ["**/flights/**", "**/flight*"],
  },
  {
    id: "almosafer-hotels",
    name: "Almosafer — Hotels",
    baseUrl: "https://www.almosafer.com/hotels",
    specGlobs: ["**/hotels/**", "**/hotel*"],
  },
  {
    id: "tajawal-web",
    name: "Tajawal — Web",
    baseUrl: "https://www.tajawal.com",
    specGlobs: [],
  },
  {
    id: "custom",
    name: "Custom (set base URL in the form)",
    baseUrl: "",
    specGlobs: [],
  },
];

export function findProduct(id) {
  return PRODUCTS.find((p) => p.id === id) || null;
}
