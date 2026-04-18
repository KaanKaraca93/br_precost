/**
 * Mock attribute definitions.
 * Bu veriler ileride PLM API'sinden (FashionPLM OData) çekilecek.
 * Şimdilik sabit liste kullanıyoruz.
 *
 * Format: { "Attribute Adı": ["Değer1", "Değer2", ...] }
 */
const ATTRIBUTES = {
  "Astar Tipi":    ["Tam Astar", "Yarım Astar", "Astarsız"],
  "Desen":         ["Düz", "Desenli", "Ekoseli", "Çizgili"],
  "Koleksiyon":    ["Basic", "Premium", "Luxury"],
  "Kol Tipi":      ["Kolsuz", "Kısa Kol", "Uzun Kol"],
  "Kalıp":         ["Slim Fit", "Regular Fit", "Oversize"],
  "Yaka":          ["Yaka Yok", "Hakim Yaka", "Gömlek Yaka", "Kapüşon"],
};

module.exports = { ATTRIBUTES };
