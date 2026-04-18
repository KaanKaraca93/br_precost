/**
 * PLM Generic Lookup → Attribute tanımları
 *
 * GlRefId → { label: Türkçe ad, type: "selector"|"cost-attr" }
 *
 * type:
 *   "selector"   → Sezon / Marka / Kategori gibi kombinasyon seçici alanlarda kullanılır
 *   "cost-attr"  → Kullanıcının maliyet parametresi olarak seçeceği özellikler
 *
 * Değerler (values) şu an mock'tur.
 * İleride: PLM /GenericLookUpAll?$filter=GlrefId eq <id> and Status eq 1
 * endpoint'inden çekilecek ve Name alanı kullanılacak.
 */

const GLREF_MAP = {
  1:   { label: "Marka",         type: "selector"  },
  58:  { label: "Sezon",         type: "selector"  },
  51:  { label: "Kategori",      type: "selector"  },
  72:  { label: "Fit Bilgisi",   type: "cost-attr" },
  73:  { label: "Astar Tipi",    type: "cost-attr" },
  74:  { label: "Yaka Tipi",     type: "cost-attr" },
  75:  { label: "Cep Tipi",      type: "cost-attr" },
  103: { label: "Desen Tipi",    type: "cost-attr" },
  232: { label: "Yırtmaç Tipi", type: "cost-attr" },
  233: { label: "Kol Tipi",      type: "cost-attr" },
  234: { label: "Kumaş Tipi",   type: "cost-attr" },
};

/**
 * Mock değer listeleri — PLM GenericLookUpAll entegrasyonuna kadar kullanılır.
 * PLM'deki değer sırası/adları farklılık gösterebilir, entegrasyon sonrası silinecek.
 */
const MOCK_VALUES = {
  72:  ["Slim Fit", "Regular Fit", "Comfort Fit", "Oversize"],
  73:  ["Tam Astar", "Yarım Astar", "Astarsız"],
  74:  ["Hakim Yaka", "Gömlek Yaka", "Bisiklet Yaka", "Kapüşon", "Yaka Yok"],
  75:  ["Cepsiz", "Yama Cep", "Yan Cep", "İç Cep", "Kapak Cep"],
  103: ["Düz", "Desenli", "Ekoseli", "Çizgili"],
  232: ["Yırtmaç Yok", "Arka Yırtmaç", "Yan Yırtmaç"],
  233: ["Kolsuz", "Kısa Kol", "3/4 Kol", "Uzun Kol"],
  234: ["Dokuma", "Örme", "Denim", "Polar", "Kadife"],
};

/**
 * Widget attribute seçim panelinde gösterilecek attribute'ları döner.
 * Yalnızca type="cost-attr" olanlar.
 * Format: { "Astar Tipi": ["Tam Astar", "Yarım Astar", ...], ... }
 */
function getCostAttributes() {
  const result = {};
  for (const [glRefId, def] of Object.entries(GLREF_MAP)) {
    if (def.type !== "cost-attr") continue;
    result[def.label] = MOCK_VALUES[glRefId] || [];
  }
  return result;
}

module.exports = { GLREF_MAP, getCostAttributes };
