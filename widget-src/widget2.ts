import { IWidgetContext, IWidgetInstance, Log } from "lime";

declare var $: JQueryStatic;

const API_BASE = "/CustomerApi/brprecostparams";
const PLM_BASE = "/FASHIONPLM/odata2/api/odata2";

// Sezon/Marka/Kategori → STYLE alanı (filter için)
const SELECTOR_STYLE_FIELD: { [label: string]: string } = {
  "Sezon":    "SeasonId",
  "Marka":    "BrandId",
  "Kategori": "CategoryId",
};

// Standart cost-attr GlRefId → STYLE alanı
const STANDARD_ATTR_FIELD: { [glRefId: string]: string } = {
  "72":  "UserDefinedField1Id",
  "73":  "UserDefinedField2Id",
  "74":  "UserDefinedField3Id",
  "75":  "UserDefinedField4Id",
  "103": "MarketField4Id",
  "232": "UserDefinedField5Id",
  "233": "UserDefinedField6Id",
  "234": "UserDefinedField7Id",
};

// STYLE Status filtresi (kullanıcı sabitledi)
const STYLE_STATUS_FILTER = "(Status eq 106 or Status eq 108 or Status eq 102 or Status eq 101 or Status eq 4)";

// 150 cm baz, her 2 cm değişim ±0.01 m sarf
const BASE_FABRIC_WIDTH = 150;
const ADJUSTMENT_PER_2CM = 0.01;

// Maliyet kategorileri (Widget 2 — patch widget'ı)
// Malzeme ve Astar/Garni şimdilik listede yok.
interface CostCategory {
  key: string;
  icon: string;
  title: string;
  desc: string;
  status: "ready" | "wip";
}
const COST_CATEGORIES: CostCategory[] = [
  { key: "ana-kumash",   icon: "🧵", title: "Ana Kumaş Sarf",     desc: "Ana kumaşı eksik modelleri bulup PLM'e sarf yazar", status: "ready" },
  { key: "iscilik",      icon: "👷", title: "İşçilik",            desc: "İşçilik maliyeti eksik modelleri bulur ve yazar",   status: "wip" },
  { key: "uretim-paket", icon: "📦", title: "Üretim & Paketleme", desc: "Üretim ve paketleme maliyeti eksik modeller",       status: "wip" },
];

function getCategory(key: string | null): CostCategory | null {
  if (!key) return null;
  return COST_CATEGORIES.find(c => c.key === key) || null;
}

// Patch akışı sabitleri
const PLM_VIEW_BASE = "/FASHIONPLM/view/api/view";
const PLM_PDM_BASE  = "/FASHIONPLM/pdm/api/pdm";
const PLM_CLIENT_VERSION = "16.0.32";
const PATCH_USER_ID = 124;
const PATCH_EXCHANGE_RATE_TYPE = 1;
const PATCH_EXCHANGE_RATE_DATE = "2024-04-20T00:00:00Z";
const PATCH_QUANTITY_UOM_ID    = "9";    // mt
const PATCH_CURRENCY_ID        = 4;
const PATCH_SCHEMA             = "FSH1";

// Costing save için sabit settings (PLM örnek payload'undan birebir alındı)
const COSTING_SAVE_SETTINGS = {
  key: "bomdetails",
  value: JSON.stringify({
    decimalCount: { qty: 3 },
    colorFormat:  { type: "3", withPitch: true },
    costingDefaults: { defexchratetype: 1 },
    autoCascadeDataToBOM: {
      autoCascadeMaterial: { isActive: true, fields: { Code: true, Name: true, Description: true, Notes: false, MainCategoryId: true, ComponentCategoryGroupId: true, CategoryId: true, Image: true, Placement: true, Composition: true, FreeFieldCert: true, IsCriticalMaterial: true, IsChemicalWarning: true, Status: true, QuantityUOM: false, WastePercent: true, CurrencyId: true, PurchasePrice: true, Construction: true, Weight: true, WeightUOMId: true, Finish: true, UserDefinedField1: true, UserDefinedField2: true, UserDefinedField3: true, UserDefinedField4: true, UserDefinedField12: true, UserDefinedField13: true, Operational: true, FreeField1: true, FreeField2: true, FreeField3: true, FreeField4: false, ERPCode: true, IntegrationStatus: false } },
      autoCascadeTrim:     { isActive: true, fields: { Code: true, Name: true, Description: true, Notes: true,  MainCategoryId: true, ComponentCategoryGroupId: true, CategoryId: true, Image: true, Placement: true, Composition: true, FreeFieldCert: true, IsCriticalMaterial: true, IsChemicalWarning: true, Status: true, QuantityUOM: false, WastePercent: true, CurrencyId: true, PurchasePrice: true, Construction: true, Weight: true, WeightUOMId: true, Finish: true, UserDefinedField1: true, UserDefinedField2: true, UserDefinedField3: true, UserDefinedField4: true, UserDefinedField12: true, UserDefinedField13: true, Operational: true, FreeField1: true, FreeField2: true, FreeField3: true, FreeField4: true,  ERPCode: true, IntegrationStatus: true  } },
      autoCascadeStyle:    { isActive: false, fields: { CategoryId: false, SubCategoryId: false, ProductSubSubCategoryId: false, CostPrice: false, CurrencyId: false, Description: false, FreeField1: false, FreeField2: false, FreeField3: false, FreeField4: false, Image: false, Name: false, Notes: false, Number: false, PurchasePrice: false, UOMId: false, Status: false, UserDefinedField1: false, UserDefinedField2: false, UserDefinedField3: false, UserDefinedField4: false, UserDefinedField12: false, UserDefinedField13: false, ERPCode: false, IntegrationStatus: false, Code: false } },
      enableAutoCascade: true,
      enableSyncMainSupplier: true,
    },
    calculations: [],
    checkboxBomSequenceSettings: { enableBomSequenceSettings: true },
    checkBoxRemoveBOMLineSettings: { enableSMTFreeField3: true, enablePlacement: true },
    checkBoxBomGeocodeSettings: { enableGeocode: false },
    bomStyleSetSettings: { IsUniqueStyleSets: true },
    bomMainMaterialSettings: { isOneMaterialOnly: false, isMultipleMaterial: false },
  }),
  workFlow: null, careGroup: null, category: null,
  requestType: null, requestSubType: null, requestStatus: null,
  sourcingTag: null, dataSchemas: null, massCreateModules: null,
};

// ── Veri tipleri ─────────────────────────────────────────────────────────────

interface LookupValue { id: string | null; name: string; code: string | null; seq: number; }
interface LookupAttribute {
  role: "selector" | "cost-attr" | "reference";
  source: "standard" | "extended";
  sourceId: string;
  label: string;
  values: LookupValue[];
}

interface BulkConfig {
  season: string;
  brand: string;
  styleCategory: string;
  selectedAttrs: string[];
  values: { attrCombo: { [attr: string]: string }; consumption: number | null; unit: string }[];
}

interface ResultRow {
  styleId: number;
  styleCode: string;
  name: string;
  brand: string;
  category: string;
  styleBomId: number | null;
  bomLineId: number | null;
  booId: number | null;
  bomLine: any;             // raw bom line
  currentQty: number | null;
  fabricCode: string;
  fabricWidthCm: number | null;
  combo: { [attr: string]: string };   // attribute label → name
  comboReadable: string;               // for display
  matchStatus: "match" | "partial" | "none" | "no-config";
  baseSuggestion: number | null;       // 150cm baz öneri
  adjustedSuggestion: number | null;   // kumaş enine göre düzeltilmiş
  reason: string;                      // kullanıcıya açıklama
  selected: boolean;
  patchStatus: "idle" | "pending" | "running" | "done" | "error";
  patchMsg: string;
}

// ── Widget ────────────────────────────────────────────────────────────────────

class CostMissingWidget implements IWidgetInstance {
  private $el: JQuery;

  // cache state
  private allAttrs:    LookupAttribute[] = [];
  private byLabel:     { [label: string]: LookupAttribute } = {};
  private bySource:    { [source: string]: { [sourceId: string]: LookupAttribute } } = { standard: {}, extended: {}, };
  private widthRef:    LookupAttribute | null = null;
  private lastRefreshedAt: string | null = null;

  // selection state
  private currentCategory: string | null = null;
  private season:      string = "";
  private brands:      string[] = [];
  private categories:  string[] = [];
  private results:     ResultRow[] = [];
  private bulkConfigs: BulkConfig[] = [];
  private loading:     boolean = false;
  private toastTimer:  any = null;
  private totalFetched: number = 0;
  private applying:     boolean = false;

  // multi-select popover state
  private openPicker:  string | null = null;

  constructor(private widgetContext: IWidgetContext) {
    this.$el = widgetContext.getElement();
    this.renderShell();
    this.bindAll();
    this.fetchLookup();
    this.renderCategoryPicker();
  }

  settingsSaved(): void {}
  dispose(): void { this.$el.off(); }

  // ── Cache fetch ─────────────────────────────────────────────────────────────

  private fetchLookup(): void {
    this.apiGet("/api/lookup/all",
      (data: any) => this.applyLookup(data),
      (err: any) => Log.error("[CostMissing] /api/lookup/all error: " + JSON.stringify(err))
    );
  }

  private applyLookup(data: any): void {
    const attrs: LookupAttribute[] = (data && data.attributes) ? data.attributes : [];
    this.allAttrs = attrs;
    this.byLabel  = {};
    this.bySource = { standard: {}, extended: {} };
    this.widthRef = null;
    for (const a of attrs) {
      this.byLabel[a.label] = a;
      if (!this.bySource[a.source]) this.bySource[a.source] = {};
      this.bySource[a.source][a.sourceId] = a;
      if (a.role === "reference" && a.label === "Kumaş Eni") this.widthRef = a;
    }
    this.lastRefreshedAt = data ? data.lastRefreshedAt : null;
    this.renderHeader();
    if (this.currentCategory === "ana-kumash") this.populatePickers();
  }

  // ── Multi-select pickers ───────────────────────────────────────────────────

  private populatePickers(): void {
    if (this.$el.find("#cm-pick-season").length === 0) return;
    this.renderPicker("season",   "Sezon");
    this.renderPicker("brand",    "Marka");
    this.renderPicker("category", "Kategori");
  }

  private renderPicker(key: string, label: string): void {
    const attr = this.byLabel[label];
    if (!attr) return;

    const isMulti  = (key === "brand" || key === "category");
    const selected = key === "season" ? (this.season ? [this.season] : [])
                   : key === "brand"  ? this.brands
                                      : this.categories;

    const chip = selected.length === 0
      ? `<span style="color:#adb5bd;">Seçiniz…</span>`
      : selected.map(v =>
          `<span style="display:inline-block;background:#e8f0fa;color:#1D5FA3;padding:2px 8px;border-radius:10px;font-size:11px;margin:1px 3px 1px 0;">${v}</span>`
        ).join("");

    const items = attr.values.map(v => {
      const checked = selected.indexOf(v.name) !== -1;
      const inputType = isMulti ? "checkbox" : "radio";
      const appearance = isMulti ? "checkbox" : "radio";
      const inputStyle = `width:16px;height:16px;min-width:16px;min-height:16px;padding:0;margin:0;flex:none;appearance:auto;-webkit-appearance:${appearance};-moz-appearance:${appearance};cursor:pointer;`;
      return `<label style="display:flex;align-items:center;gap:8px;padding:5px 10px;cursor:pointer;border-radius:4px;font-size:12px;" onmouseover="this.style.background='#f1f3f5'" onmouseout="this.style.background='transparent'">
        <input type="${inputType}" name="cm-pick-${key}" value="${esc(v.name)}" ${checked ? "checked" : ""} style="${inputStyle}" />
        <span>${v.name}</span>
      </label>`;
    }).join("");

    const popoverShown = this.openPicker === key;

    const html = `
      <div style="position:relative;display:flex;flex-direction:column;gap:4px;flex:1;min-width:160px;">
        <label style="font-size:11px;font-weight:600;color:#6c757d;text-transform:uppercase;letter-spacing:.4px;">${label}${isMulti ? " (çoklu)" : ""}</label>
        <button data-picker="${key}" style="text-align:left;padding:7px 10px;border:1px solid #e9ecef;border-radius:6px;background:white;font-size:12px;cursor:pointer;min-height:34px;">${chip}</button>
        ${popoverShown ? `
        <div data-popover="${key}" style="position:absolute;top:100%;left:0;right:0;margin-top:4px;background:white;border:1px solid #e9ecef;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.12);max-height:280px;overflow-y:auto;z-index:50;">
          ${items || `<div style="padding:10px;font-size:12px;color:#adb5bd;text-align:center;">Veri yok — cache yenilenmesini bekleyin</div>`}
          ${isMulti ? `<div style="padding:6px 10px;border-top:1px solid #f1f3f5;display:flex;gap:6px;">
            <button data-picker-action="all" data-picker-key="${key}" style="flex:1;padding:4px;background:#f1f3f5;border:none;border-radius:4px;font-size:11px;cursor:pointer;">Tümü</button>
            <button data-picker-action="none" data-picker-key="${key}" style="flex:1;padding:4px;background:#f1f3f5;border:none;border-radius:4px;font-size:11px;cursor:pointer;">Hiçbiri</button>
          </div>` : ""}
        </div>` : ""}
      </div>`;

    this.$el.find(`#cm-pick-${key}`).html(html);
  }

  // ── Shell ───────────────────────────────────────────────────────────────────

  private renderShell(): void {
    this.$el.html(`
      <div style="font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#343a40;background:#f8f9fa;min-height:400px;position:relative;">

        <div style="background:#1D5FA3;color:white;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;gap:10px;">
          <span id="cm-title" style="font-size:14px;font-weight:600;">Maliyeti Eksik Modeller</span>
          <span style="display:flex;align-items:center;gap:8px;">
            <span id="cm-cache-info" style="font-size:11px;color:rgba(255,255,255,.85);"></span>
            <span style="background:rgba(255,255,255,.2);padding:2px 8px;border-radius:10px;font-size:11px;">PreCost v1</span>
          </span>
        </div>

        <div id="cm-content" style="padding:12px 16px;"></div>

        <div id="cm-toast" style="position:absolute;bottom:18px;right:18px;padding:10px 18px;border-radius:6px;font-size:13px;font-weight:600;color:white;box-shadow:0 4px 16px rgba(0,0,0,.2);opacity:0;transition:opacity .25s;z-index:1000;pointer-events:none;"></div>
      </div>
    `);
  }

  private setContent(html: string): void { this.$el.find("#cm-content").html(html); }

  // ── Kategori Picker ────────────────────────────────────────────────────────

  private renderCategoryPicker(): void {
    this.currentCategory = null;
    this.$el.find("#cm-title").text("Maliyeti Eksik Modeller");

    const cards = COST_CATEGORIES.map(c => {
      const wip = c.status !== "ready";
      const badge = wip
        ? `<span style="background:#fff3e0;color:#e65100;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;">🚧 WIP</span>`
        : `<span style="background:#e8f5e9;color:#2e7d32;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;">HAZIR</span>`;
      return `<div data-cat="${c.key}" style="border:1px solid #e9ecef;background:white;border-radius:8px;padding:16px;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.08);transition:border-color .15s,transform .1s;" onmouseover="this.style.borderColor='#1D5FA3'" onmouseout="this.style.borderColor='#e9ecef'">
        <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:8px;">
          <div style="font-size:32px;">${c.icon}</div>
          <div style="flex:1;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px;">
              <span style="font-weight:700;font-size:14px;">${c.title}</span>
              ${badge}
            </div>
            <div style="font-size:12px;color:#6c757d;line-height:1.4;">${c.desc}</div>
          </div>
        </div>
      </div>`;
    }).join("");

    this.setContent(`
      <div style="margin-bottom:14px;">
        <div style="font-size:13px;font-weight:600;color:#343a40;margin-bottom:4px;">Hangi maliyet kategorisinde işlem yapacaksınız?</div>
        <div style="font-size:12px;color:#6c757d;">Bir kategori seçin — eksik modelleri listeleyin ve PLM'e yazın.</div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;">${cards}</div>
    `);
  }

  private enterCategory(key: string): void {
    const cat = getCategory(key);
    if (!cat) return;
    if (cat.status !== "ready") {
      this.renderUnderConstruction(cat);
      return;
    }
    this.currentCategory = key;
    if (key === "ana-kumash") this.renderAnaKumashShell();
  }

  private renderUnderConstruction(cat: CostCategory): void {
    this.currentCategory = cat.key;
    this.$el.find("#cm-title").html(this.crumbHtml(cat.title));
    this.setContent(`
      <div style="background:white;border:1px dashed #e0e0e0;border-radius:8px;padding:60px 20px;text-align:center;">
        <div style="font-size:48px;margin-bottom:12px;">${cat.icon}</div>
        <div style="font-size:16px;font-weight:700;color:#343a40;margin-bottom:6px;">${cat.title}</div>
        <div style="font-size:13px;color:#6c757d;margin-bottom:18px;">${cat.desc}</div>
        <div style="display:inline-block;background:#fff3e0;color:#e65100;padding:8px 18px;border-radius:20px;font-size:13px;font-weight:600;">🚧 Yapım aşamasında</div>
        <div style="margin-top:24px;">
          <button id="cm-back-home2" style="padding:7px 16px;background:#1D5FA3;color:white;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;">← Kategori Seçimine Dön</button>
        </div>
      </div>
    `);
  }

  private crumbHtml(title: string): string {
    return `<button id="cm-back-home" style="background:rgba(255,255,255,.15);color:white;border:none;border-radius:4px;padding:3px 9px;font-size:12px;cursor:pointer;margin-right:6px;">← Kategoriler</button> <span style="opacity:.7;">/</span> ${title}`;
  }

  private renderAnaKumashShell(): void {
    this.$el.find("#cm-title").html(this.crumbHtml("🧵 Ana Kumaş — Eksik Modeller"));

    this.setContent(`
      <div style="background:white;border:1px solid #e9ecef;border-radius:6px;padding:10px 14px;margin-bottom:14px;display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;box-shadow:0 1px 4px rgba(0,0,0,.08);">
        <div id="cm-pick-season"   style="flex:1;min-width:160px;"></div>
        <div id="cm-pick-brand"    style="flex:1.5;min-width:200px;"></div>
        <div id="cm-pick-category" style="flex:1.5;min-width:200px;"></div>
        <button id="cm-list" style="padding:7px 16px;background:#1D5FA3;color:white;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;">Listele</button>
      </div>

      <div id="cm-main">
        <div style="text-align:center;padding:40px 20px;color:#6c757d;">
          <div style="font-size:36px;margin-bottom:8px;">📋</div>
          <p>Sezon, marka(lar) ve kategori(ler) seçip <strong>Listele</strong>'ye basın</p>
          <p style="font-size:12px;color:#adb5bd;margin-top:6px;">Sadece ana kumaş <code>Quantity</code> değeri 0 veya null olan modeller gösterilir.</p>
        </div>
      </div>
    `);

    this.populatePickers();
  }

  private goHome(): void {
    this.season = "";
    this.brands = [];
    this.categories = [];
    this.results = [];
    this.bulkConfigs = [];
    this.totalFetched = 0;
    this.openPicker = null;
    this.renderCategoryPicker();
  }

  private renderHeader(): void {
    const txt = this.lastRefreshedAt
      ? "Cache: " + this.formatAge(this.lastRefreshedAt)
      : "Cache yükleniyor…";
    this.$el.find("#cm-cache-info").text(txt);
  }

  // ── Event delegation ────────────────────────────────────────────────────────

  private bindAll(): void {
    // Picker buttons (toggle popover)
    this.$el.on("click", "[data-picker]", (e: JQueryEventObject) => {
      e.stopPropagation();
      const key = $(e.currentTarget).attr("data-picker") as string;
      this.openPicker = (this.openPicker === key) ? null : key;
      this.renderPicker(key, key === "season" ? "Sezon" : key === "brand" ? "Marka" : "Kategori");
    });

    // Checkbox/radio inside popover
    this.$el.on("change", "[name^='cm-pick-']", (e: JQueryEventObject) => {
      const $t  = $(e.currentTarget);
      const key = ($t.attr("name") as string).replace("cm-pick-", "");
      const val = $t.val() as string;
      const checked = $t.is(":checked");
      if (key === "season") {
        this.season = checked ? val : "";
      } else if (key === "brand") {
        this.brands = this.toggleArray(this.brands, val, checked);
      } else if (key === "category") {
        this.categories = this.toggleArray(this.categories, val, checked);
      }
      this.renderPicker(key, key === "season" ? "Sezon" : key === "brand" ? "Marka" : "Kategori");
    });

    // Tümü / Hiçbiri
    this.$el.on("click", "[data-picker-action]", (e: JQueryEventObject) => {
      e.stopPropagation();
      const action = $(e.currentTarget).attr("data-picker-action");
      const key    = $(e.currentTarget).attr("data-picker-key") as string;
      const attr   = this.byLabel[key === "brand" ? "Marka" : "Kategori"];
      const allNames = attr ? attr.values.map(v => v.name) : [];
      const newSel = action === "all" ? allNames.slice() : [];
      if (key === "brand")    this.brands     = newSel;
      if (key === "category") this.categories = newSel;
      this.renderPicker(key, key === "brand" ? "Marka" : "Kategori");
    });

    // Outside click — close popover
    this.$el.on("click", (e: JQueryEventObject) => {
      if (!this.openPicker) return;
      const $tgt = $(e.target);
      if ($tgt.closest("[data-picker], [data-popover]").length === 0) {
        this.openPicker = null;
        this.populatePickers();
      }
    });

    // Listele
    this.$el.on("click", "#cm-list", () => this.runListing());

    // Kategori picker → girilen kategori
    this.$el.on("click", "[data-cat]", (e: JQueryEventObject) => {
      const key = $(e.currentTarget).attr("data-cat") as string;
      this.enterCategory(key);
    });

    // Header back butonu — kategori seçimine dön
    this.$el.on("click", "#cm-back-home, #cm-back-home2", () => this.goHome());

    // Sonuç tablosu — checkbox & uygula
    this.$el.on("change", ".cm-row-chk", (e: JQueryEventObject) => {
      const i = parseInt($(e.currentTarget).attr("data-row") || "-1", 10);
      if (i < 0 || !this.results[i]) return;
      this.results[i].selected = $(e.currentTarget).is(":checked");
      this.renderResults();
    });
    this.$el.on("change", "#cm-chk-all", (e: JQueryEventObject) => {
      const checked = $(e.currentTarget).is(":checked");
      for (const r of this.results) {
        if (this.isApplicable(r) && r.patchStatus !== "done" && r.patchStatus !== "running") r.selected = checked;
      }
      this.renderResults();
    });
    this.$el.on("click", "[data-apply]", (e: JQueryEventObject) => {
      const i = parseInt($(e.currentTarget).attr("data-apply") || "-1", 10);
      if (i < 0 || !this.results[i]) return;
      this.applyOne(i, /* fromBulk */ false);
    });
    this.$el.on("click", "#cm-apply-bulk", () => this.applyBulk());
  }

  private isApplicable(r: ResultRow): boolean {
    return r.adjustedSuggestion !== null
        && r.bomLineId !== null
        && r.styleBomId !== null;
  }

  private applicableReason(r: ResultRow): string {
    if (r.adjustedSuggestion === null) return "Önerilen sarf hesaplanamadı";
    if (r.bomLineId === null)          return "Ana kumaş BOMLine yok";
    if (r.styleBomId === null)         return "StyleBOM yok";
    return "";
  }

  private toggleArray(arr: string[], val: string, add: boolean): string[] {
    if (add) {
      return arr.indexOf(val) === -1 ? [...arr, val] : arr;
    }
    return arr.filter(x => x !== val);
  }

  // ── Listele akışı ───────────────────────────────────────────────────────────

  private runListing(): void {
    if (this.loading) return;

    if (!this.season || this.brands.length === 0 || this.categories.length === 0) {
      this.toast("Sezon, marka ve kategori seçin", "error"); return;
    }

    const seasonAttr = this.byLabel["Sezon"];
    const brandAttr  = this.byLabel["Marka"];
    const catAttr    = this.byLabel["Kategori"];
    if (!seasonAttr || !brandAttr || !catAttr) {
      this.toast("Cache henüz yüklenmedi, biraz sonra tekrar deneyin", "error"); return;
    }

    const seasonId = this.idOf(seasonAttr, this.season);
    const brandIds = this.brands.map(n => this.idOf(brandAttr, n)).filter(x => x !== null) as string[];
    const catIds   = this.categories.map(n => this.idOf(catAttr, n)).filter(x => x !== null) as string[];

    if (seasonId === null || brandIds.length === 0 || catIds.length === 0) {
      this.toast("Seçilen değerlerin ID karşılığı cache'te yok — cache'i yenileyin", "error"); return;
    }

    this.loading = true;
    this.setMain(this.emptyState("⏳", "Bulk config + STYLE çağrıları yapılıyor…"));

    // 1) Bulk config → bizim DB'mizden parametreler
    this.apiPost("/api/ana-kumash/lookup-bulk",
      { season: this.season, brands: this.brands, categories: this.categories },
      (bulk: BulkConfig[]) => {
        this.bulkConfigs = bulk || [];

        // 2) Hangi extended ExtFldId'ler kullanılıyor?
        const extFldIds = this.collectExtendedFldIds(this.bulkConfigs);

        // 3) STYLE çağrısı
        const url = this.buildStyleUrl(seasonId, brandIds, catIds, extFldIds);
        this.ionGet(url,
          (styleRes: any) => {
            const styles: any[] = (styleRes && styleRes.value) ? styleRes.value : [];
            this.totalFetched = styles.length;
            Log.debug(`[CostMissing] STYLE returned ${styles.length} models`);
            this.results = this.processStyles(styles);
            this.loading = false;
            this.renderResults();
          },
          (err: any) => {
            this.loading = false;
            Log.error("[CostMissing] PLM STYLE error: " + JSON.stringify(err));
            this.setMain(this.emptyState("⚠️", "STYLE çağrısı başarısız: " + (err && err.statusText ? err.statusText : "PLM hatası")));
          }
        );
      },
      (err: any) => {
        this.loading = false;
        Log.error("[CostMissing] /lookup-bulk error: " + JSON.stringify(err));
        this.setMain(this.emptyState("⚠️", "Bulk config çağrısı başarısız"));
      }
    );
  }

  private collectExtendedFldIds(bulk: BulkConfig[]): string[] {
    const set: { [k: string]: true } = {};
    for (const b of bulk) {
      for (const label of b.selectedAttrs) {
        const a = this.byLabel[label];
        if (a && a.source === "extended") set[a.sourceId] = true;
      }
    }
    return Object.keys(set);
  }

  private buildStyleUrl(seasonId: string, brandIds: string[], catIds: string[], extFldIds: string[]): string {
    const filter = `IsDeleted eq 0 and SeasonId eq ${seasonId} and ${STYLE_STATUS_FILTER}` +
      ` and CategoryId in (${catIds.join(",")}) and BrandId in (${brandIds.join(",")})`;

    let expand =
      `StyleBOM($select=Id,Name;$expand=BOMLine($select=Id,Code,Name,Composition,Weight,UserDefinedField12,PurchasePrice,CurrencyId,Quantity;$filter=IsMainLine eq true)),` +
      `StyleCosting($select=Id),` +
      `StyleBOO($select=Id)`;

    if (extFldIds.length > 0) {
      const guidList = extFldIds.map(g => g).join(",");
      expand += `,StyleExtendedFieldValues($select=StyleId,Id,ExtFldId,DropdownValues;$filter=ExtFldId in (${guidList});$expand=StyleExtendedFields($select=Name))`;
    }

    return `${PLM_BASE}/STYLE?$filter=${encodeURIComponent(filter)}&$expand=${encodeURIComponent(expand)}`;
  }

  // ── STYLE → ResultRow dönüşümü ─────────────────────────────────────────────

  private processStyles(styles: any[]): ResultRow[] {
    const out: ResultRow[] = [];
    const brandAttr = this.byLabel["Marka"];
    const catAttr   = this.byLabel["Kategori"];

    for (const s of styles) {
      // Ana kumaş line'ını tüm BOM'larda ara (genellikle StyleBOM[0].BOMLine[0]).
      // Birden fazla BOM varsa main line'ı barındıran ilk match'i al.
      let line: any = null;
      let styleBomId: number | null = null;
      const boms: any[] = Array.isArray(s.StyleBOM) ? s.StyleBOM : [];
      for (const b of boms) {
        const lines: any[] = Array.isArray(b && b.BOMLine) ? b.BOMLine : [];
        if (lines.length > 0) { line = lines[0]; styleBomId = b.Id; break; }
      }
      if (styleBomId === null && boms.length > 0) styleBomId = boms[0].Id;

      const boos: any[] = Array.isArray(s.StyleBOO) ? s.StyleBOO : [];
      const booId: number | null = boos.length > 0 ? boos[0].Id : null;

      const qty = (line && line.Quantity !== undefined && line.Quantity !== null)
        ? parseFloat(line.Quantity)
        : null;

      // Modeli listeye dahil etme kuralı:
      //   - Main BOMLine YOK → ana kumaş tanımı yok, listele (kullanıcı görmek ister)
      //   - Main BOMLine var ama qty 0/null → eksik, listele
      //   - Main BOMLine var ve qty > 0 → tam, gösterme
      if (line && qty !== null && qty > 0) continue;

      const brandName = brandAttr ? this.nameOf(brandAttr, String(s.BrandId)) : String(s.BrandId);
      const catName   = catAttr   ? this.nameOf(catAttr,   String(s.CategoryId)) : String(s.CategoryId);

      // Combo'yu kullanıcının tanımladığı parametreler için doldur
      const config = this.bulkConfigs.find(b => b.brand === brandName && b.styleCategory === catName);
      const combo: { [attr: string]: string } = {};
      let comboFullyResolved = true;
      let matchStatus: ResultRow["matchStatus"] = "none";
      let baseSuggestion: number | null = null;
      let reason = "";

      if (!config) {
        matchStatus = "no-config";
        reason = `Bu marka/kategori için parametre tanımı yok (${brandName} / ${catName})`;
      } else {
        // Her seçili attribute için STYLE'dan değer çek
        for (const label of config.selectedAttrs) {
          const attr = this.byLabel[label];
          if (!attr) { combo[label] = "?"; comboFullyResolved = false; continue; }

          let valueId: string | null = null;
          if (attr.source === "standard") {
            const field = STANDARD_ATTR_FIELD[attr.sourceId];
            if (field && s[field] !== undefined && s[field] !== null) {
              valueId = String(s[field]);
            }
          } else if (attr.source === "extended") {
            const exts = (s.StyleExtendedFieldValues || []) as any[];
            const match = exts.find(e => e.ExtFldId === attr.sourceId);
            if (match && match.DropdownValues) valueId = String(match.DropdownValues);
          }

          if (valueId !== null) {
            const name = this.nameOf(attr, valueId);
            combo[label] = name || `[${valueId}]`;
            if (!name) comboFullyResolved = false;
          } else {
            combo[label] = "—";
            comboFullyResolved = false;
          }
        }

        // Combo'ya uyan kayıtlı sarf değerini bul
        if (comboFullyResolved) {
          const found = config.values.find(v => this.combosEqual(v.attrCombo, combo));
          if (found && found.consumption !== null) {
            matchStatus    = "match";
            baseSuggestion = found.consumption;
            reason = "150 cm baz değer";
          } else {
            matchStatus = "partial";
            reason = "Bu kombinasyon için sarf değeri girilmemiş";
          }
        } else {
          matchStatus = "partial";
          reason = "Kombinasyon eksik / cache'te ID karşılığı yok";
        }
      }

      // Kumaş eni — line yoksa null
      const widthCm = line ? this.resolveFabricWidth(line.UserDefinedField12) : null;
      const adjusted = (baseSuggestion !== null && widthCm !== null)
        ? this.adjustForWidth(baseSuggestion, widthCm)
        : baseSuggestion;

      out.push({
        styleId:       s.StyleId,
        styleCode:     s.StyleCode || "",
        name:          s.Name || "",
        brand:         brandName,
        category:      catName,
        styleBomId:    styleBomId,
        bomLineId:     line && line.Id ? line.Id : null,
        booId:         booId,
        bomLine:       line,
        currentQty:    qty,
        fabricCode:    line ? (line.Code || "") : "",
        fabricWidthCm: widthCm,
        combo:         combo,
        comboReadable: Object.keys(combo).length === 0 ? "—" : Object.entries(combo).map(([k, v]) => `${k}: ${v}`).join(", "),
        matchStatus:   matchStatus,
        baseSuggestion,
        adjustedSuggestion: adjusted,
        reason,
        selected:    false,
        patchStatus: "idle",
        patchMsg:    "",
      });
    }

    return out;
  }

  private resolveFabricWidth(udf12: any): number | null {
    if (udf12 === null || udf12 === undefined || udf12 === "") return null;
    if (!this.widthRef) return null;
    const id = String(udf12);
    const found = this.widthRef.values.find(v => v.id === id);
    if (!found) return null;
    // Kullanıcı dedi ki: Code kısmında cm değeri tutuluyor (string ama integer)
    const code = found.code !== null && found.code !== undefined ? parseInt(String(found.code).replace(/[^0-9]/g, ""), 10) : NaN;
    if (!isNaN(code)) return code;
    // Code yoksa Name dene
    const nameNum = parseInt(String(found.name).replace(/[^0-9]/g, ""), 10);
    return isNaN(nameNum) ? null : nameNum;
  }

  private adjustForWidth(base150: number, actualEn: number): number {
    // 150 → base, ±2cm = ±0.01m (dar = +artış, geniş = -azalış)
    const delta = (BASE_FABRIC_WIDTH - actualEn) / 2 * ADJUSTMENT_PER_2CM;
    return Math.round((base150 + delta) * 1000) / 1000;
  }

  private combosEqual(a: { [k: string]: string }, b: { [k: string]: string }): boolean {
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    if (ak.length !== bk.length) return false;
    for (let i = 0; i < ak.length; i++) {
      if (ak[i] !== bk[i]) return false;
      if (a[ak[i]] !== b[bk[i]]) return false;
    }
    return true;
  }

  // ── Sonuçları render ────────────────────────────────────────────────────────

  private renderResults(): void {
    if (this.results.length === 0) {
      const msg = this.totalFetched === 0
        ? "PLM'den seçili kriterlere uygun model dönmedi (filtre/yetki kontrolü)"
        : `PLM ${this.totalFetched} model döndürdü, hepsinde ana kumaş sarfı tanımlı (qty > 0). Eksik model yok.`;
      this.setMain(this.emptyState("✅", msg));
      return;
    }

    const matchCounts = {
      match:     this.results.filter(r => r.matchStatus === "match").length,
      partial:   this.results.filter(r => r.matchStatus === "partial").length,
      none:      this.results.filter(r => r.matchStatus === "none").length,
      noConfig:  this.results.filter(r => r.matchStatus === "no-config").length,
    };
    const applicableCount = this.results.filter(r => this.isApplicable(r)).length;
    const selectedCount   = this.results.filter(r => r.selected && this.isApplicable(r)).length;

    const TH = "text-align:left;padding:7px 10px;background:#f1f3f5;border-bottom:2px solid #e9ecef;font-size:11px;font-weight:700;color:#6c757d;text-transform:uppercase;white-space:nowrap;";
    const TD = "padding:7px 10px;border-bottom:1px solid #f1f3f5;vertical-align:top;font-size:12px;";

    const rows = this.results.map((r, i) => {
      const status = this.statusBadge(r.matchStatus);
      const widthTxt = r.fabricWidthCm !== null ? `${r.fabricWidthCm} cm` : `<span style="color:#adb5bd;">?</span>`;
      const baseTxt = r.baseSuggestion !== null ? `${r.baseSuggestion.toFixed(3)} m` : "—";
      const adjTxt  = r.adjustedSuggestion !== null
        ? `<strong style="color:#1D5FA3;">${r.adjustedSuggestion.toFixed(3)} m</strong>`
        : `<span style="color:#adb5bd;">—</span>`;
      const qtyTxt = r.currentQty === null
        ? `<span style="color:#c62828;font-weight:600;">null</span>`
        : `<span style="color:#c62828;font-weight:600;">${r.currentQty}</span>`;

      const applicable = this.isApplicable(r);
      const chkStyle   = "width:16px;height:16px;min-width:16px;min-height:16px;padding:0;margin:0;flex:none;appearance:auto;-webkit-appearance:checkbox;-moz-appearance:checkbox;vertical-align:middle;";
      const checkbox = applicable
        ? `<input type="checkbox" data-row="${i}" class="cm-row-chk" ${r.selected ? "checked" : ""} ${r.patchStatus === "running" || r.patchStatus === "done" ? "disabled" : ""} style="${chkStyle}cursor:pointer;" />`
        : `<input type="checkbox" disabled title="${this.applicableReason(r)}" style="${chkStyle}cursor:not-allowed;opacity:.4;" />`;

      const applyBtn = applicable
        ? (r.patchStatus === "done"
            ? `<span style="color:#2e7d32;font-weight:700;">✓ Uygulandı</span>`
            : r.patchStatus === "running"
              ? `<span style="color:#1D5FA3;">⏳ İşleniyor…</span>`
              : `<button data-apply="${i}" style="padding:4px 10px;background:#1D5FA3;color:white;border:none;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer;">Uygula</button>`)
        : `<span style="color:#adb5bd;font-size:11px;">—</span>`;

      const errLine = r.patchStatus === "error"
        ? `<div style="color:#c62828;font-size:10px;margin-top:2px;">${r.patchMsg || "hata"}</div>`
        : "";

      return `<tr>
        <td style="${TD};text-align:center;">${checkbox}</td>
        <td style="${TD}">
          <div style="font-weight:700;color:#1D5FA3;">${r.styleCode}</div>
          <div style="color:#6c757d;font-size:11px;">${r.name}</div>
        </td>
        <td style="${TD}">${r.brand}</td>
        <td style="${TD}">${r.category}</td>
        <td style="${TD};text-align:right;">${qtyTxt}</td>
        <td style="${TD}">
          <div style="font-family:monospace;">${r.fabricCode || "—"}</div>
          <div style="color:#6c757d;font-size:11px;">En: ${widthTxt}</div>
        </td>
        <td style="${TD};font-size:11px;color:#6c757d;">${r.comboReadable || "—"}</td>
        <td style="${TD};text-align:right;">${baseTxt}</td>
        <td style="${TD};text-align:right;">${adjTxt}</td>
        <td style="${TD}">${status}<div style="font-size:10px;color:#6c757d;margin-top:2px;">${r.reason}</div>${errLine}</td>
        <td style="${TD};text-align:center;">${applyBtn}</td>
      </tr>`;
    }).join("");

    const allChecked = applicableCount > 0 && selectedCount === applicableCount;
    const bulkDisabled = selectedCount === 0 || this.applying;

    this.setMain(`
      <div style="background:white;border:1px solid #e9ecef;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.08);">
        <div style="padding:10px 16px;border-bottom:1px solid #e9ecef;display:flex;align-items:center;flex-wrap:wrap;gap:8px;">
          <span style="font-weight:700;">Sonuçlar (${this.results.length} / ${this.totalFetched} model)</span>
          <span style="background:#e8f5e9;color:#2e7d32;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">${matchCounts.match} eşleşti</span>
          <span style="background:#fff3e0;color:#e65100;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">${matchCounts.partial} kısmi</span>
          <span style="background:#ffebee;color:#c62828;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">${matchCounts.noConfig} parametresiz</span>
          <span style="margin-left:auto;display:inline-flex;align-items:center;gap:8px;">
            <span style="background:#e8f0fa;color:#1D5FA3;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;">Seçili: ${selectedCount} / Uygulanabilir: ${applicableCount}</span>
            <button id="cm-apply-bulk" ${bulkDisabled ? "disabled" : ""} style="padding:6px 14px;background:${bulkDisabled ? "#adb5bd" : "#2e7d32"};color:white;border:none;border-radius:6px;font-size:12px;font-weight:700;cursor:${bulkDisabled ? "not-allowed" : "pointer"};">
              ${this.applying ? "⏳ Uygulanıyor…" : "Seçilenleri Uygula"}
            </button>
          </span>
        </div>
        <div style="overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;">
            <thead><tr>
              <th style="${TH};text-align:center;width:34px;">
                <input type="checkbox" id="cm-chk-all" ${allChecked ? "checked" : ""} ${applicableCount === 0 || this.applying ? "disabled" : ""} style="width:16px;height:16px;min-width:16px;min-height:16px;padding:0;margin:0;flex:none;appearance:auto;-webkit-appearance:checkbox;-moz-appearance:checkbox;vertical-align:middle;cursor:pointer;" />
              </th>
              <th style="${TH}">Style</th>
              <th style="${TH}">Marka</th>
              <th style="${TH}">Kategori</th>
              <th style="${TH};text-align:right;">Mevcut Sarf</th>
              <th style="${TH}">Kumaş</th>
              <th style="${TH}">Kombinasyon</th>
              <th style="${TH};text-align:right;">Baz Öneri (150cm)</th>
              <th style="${TH};text-align:right;">Düzeltilmiş</th>
              <th style="${TH}">Eşleşme</th>
              <th style="${TH};text-align:center;">Aksiyon</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`);
  }

  private statusBadge(s: ResultRow["matchStatus"]): string {
    const cfg: { [k: string]: { bg: string; color: string; text: string } } = {
      "match":     { bg: "#e8f5e9", color: "#2e7d32", text: "✓ Eşleşti" },
      "partial":   { bg: "#fff3e0", color: "#e65100", text: "◐ Kısmi"   },
      "none":      { bg: "#ffebee", color: "#c62828", text: "✗ Yok"     },
      "no-config": { bg: "#f5f5f5", color: "#616161", text: "— Tanımsız" },
    };
    const c = cfg[s];
    return `<span style="display:inline-block;background:${c.bg};color:${c.color};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">${c.text}</span>`;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private idOf(attr: LookupAttribute, name: string): string | null {
    const v = attr.values.find(x => x.name === name);
    return v && v.id ? v.id : null;
  }

  private nameOf(attr: LookupAttribute, id: string): string {
    const v = attr.values.find(x => x.id === id);
    return v ? v.name : "";
  }

  private setMain(html: string): void { this.$el.find("#cm-main").html(html); }

  private emptyState(icon: string, msg: string): string {
    return `<div style="text-align:center;padding:40px 20px;color:#6c757d;"><div style="font-size:36px;margin-bottom:8px;">${icon}</div><p>${msg}</p></div>`;
  }

  private toast(msg: string, type: "success"|"error"|"info" = "success"): void {
    const bg = type === "success" ? "#2e7d32" : type === "error" ? "#c62828" : "#1D5FA3";
    const $t = this.$el.find("#cm-toast");
    $t.css({ background: bg, opacity: "1" }).text(msg);
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => $t.css("opacity", "0"), 3500);
  }

  private formatAge(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    const min = Math.floor(ms / 60000);
    if (min < 1)  return "az önce";
    if (min < 60) return min + " dk önce";
    const h = Math.floor(min / 60);
    if (h < 24)   return h + " saat önce";
    const d = Math.floor(h / 24);
    return d + " gün önce";
  }

  // ── API helpers ────────────────────────────────────────────────────────────

  private apiGet(path: string, onSuccess: (d: any) => void, onError: (e: any) => void): void {
    this.widgetContext.executeIonApiAsync({ method: "GET", url: `${API_BASE}${path}`, cache: false })
      .subscribe((res: any) => onSuccess(res.data), (err: any) => onError(err));
  }

  private apiPost(path: string, body: any, onSuccess: (d: any) => void, onError: (e: any) => void): void {
    this.widgetContext.executeIonApiAsync({
      method: "POST", url: `${API_BASE}${path}`, cache: false,
      data: JSON.stringify(body), headers: { "Content-Type": "application/json" },
    }).subscribe((res: any) => onSuccess(res.data), (err: any) => onError(err));
  }

  private ionGet(fullPath: string, onSuccess: (d: any) => void, onError: (e: any) => void): void {
    this.widgetContext.executeIonApiAsync({ method: "GET", url: fullPath, cache: false })
      .subscribe((res: any) => onSuccess(res.data), (err: any) => onError(err));
  }

  // ── PLM patch / save (Promise-tabanlı, sıralı zincir için) ──────────────────

  private ionRequest(method: string, url: string, body?: any, headers?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const opts: any = { method: method, url: url, cache: false };
      if (body !== undefined) {
        opts.data = typeof body === "string" ? body : JSON.stringify(body);
        opts.headers = Object.assign({ "Content-Type": "application/json" }, headers || {});
      } else if (headers) {
        opts.headers = headers;
      }
      this.widgetContext.executeIonApiAsync(opts)
        .subscribe((res: any) => resolve(res ? res.data : null), (err: any) => reject(err));
    });
  }

  // ── Patch akışı (4 adım) ───────────────────────────────────────────────────

  private async applyOne(idx: number, fromBulk: boolean): Promise<boolean> {
    const r = this.results[idx];
    if (!r || !this.isApplicable(r)) return false;
    if (r.patchStatus === "running" || r.patchStatus === "done") return r.patchStatus === "done";

    r.patchStatus = "running";
    r.patchMsg    = "";
    if (!fromBulk) this.renderResults();

    try {
      // 1) STYLEBOM setup
      const styleBomBody: any = {
        Id:               r.styleBomId,
        ExchangeRateType: PATCH_EXCHANGE_RATE_TYPE,
        ExchangeRateDate: PATCH_EXCHANGE_RATE_DATE,
      };
      if (r.booId !== null) styleBomBody.BOOVersion = r.booId;
      await this.ionRequest("PATCH", `${PLM_BASE}/STYLEBOM`, [styleBomBody]);

      // 2) BOMLINE quantity
      const qtyStr = r.adjustedSuggestion!.toFixed(3);
      await this.ionRequest("PATCH", `${PLM_BASE}/BOMLINE(${r.bomLineId})`, {
        QuantityUOMId: PATCH_QUANTITY_UOM_ID,
        Quantity:      qtyStr,
      });

      // 3) Costing rowVersionText oku
      const viewRes = await this.ionRequest("POST", `${PLM_VIEW_BASE}/layout/data/get`, {
        roleId: 1,
        userId: PATCH_USER_ID,
        personalizationId: 0,
        entity: "StyleCosting",
        pageType: "details",
        dataFilter: { conditions: [
          { FieldName: "IsDeleted", Operator: "=", Value: 0 },
          { FieldName: "StyleId",   Operator: "=", Value: String(r.styleId) },
        ] },
        pageInfo: {},
        Schema:  PATCH_SCHEMA,
      }, {
        "Content-Type": "application/json-patch+json",
        "accept":       "text/plain",
        "x-fplm-client-version": PLM_CLIENT_VERSION,
      });
      const rowVersionText = this.extractRowVersionText(viewRes);
      if (!rowVersionText) throw new Error("RowVersionText okunamadı");

      // 4) Costing save
      await this.ionRequest("POST", `${PLM_PDM_BASE}/style/costing/save`, {
        key:            String(r.styleId),
        fieldValues:    [{ fieldName: "CurrencyId", value: PATCH_CURRENCY_ID }],
        subEntities:    [],
        modifyId:       PATCH_USER_ID,
        userId:         PATCH_USER_ID,
        rowVersionText: rowVersionText,
        notificationMessageKey: "UPDATED_STYLE_COSTING",
        settings:       COSTING_SAVE_SETTINGS,
        Schema:         PATCH_SCHEMA,
      }, {
        "x-fplm-client-version": PLM_CLIENT_VERSION,
      });

      r.patchStatus = "done";
      r.patchMsg    = `${qtyStr} m yazıldı`;
      r.currentQty  = parseFloat(qtyStr);
      r.selected    = false;
      if (!fromBulk) {
        this.renderResults();
        this.toast(`${r.styleCode} güncellendi ✓`, "success");
      }
      return true;
    } catch (err: any) {
      r.patchStatus = "error";
      r.patchMsg    = this.errMsg(err);
      Log.error(`[CostMissing][apply ${r.styleCode}] ${r.patchMsg}`);
      if (!fromBulk) {
        this.renderResults();
        this.toast(`${r.styleCode}: ${r.patchMsg}`, "error");
      }
      return false;
    }
  }

  private async applyBulk(): Promise<void> {
    if (this.applying) return;
    const indexes = this.results
      .map((r, i) => ({ r, i }))
      .filter(x => x.r.selected && this.isApplicable(x.r) && x.r.patchStatus !== "done")
      .map(x => x.i);
    if (indexes.length === 0) return;

    this.applying = true;
    this.renderResults();

    let ok = 0, fail = 0;
    for (const i of indexes) {
      const success = await this.applyOne(i, /* fromBulk */ true);
      if (success) ok++; else fail++;
      this.renderResults();   // her satırdan sonra UI'yı tazele
    }

    this.applying = false;
    this.renderResults();
    this.toast(`${ok} başarılı, ${fail} hatalı`, fail === 0 ? "success" : "error");
  }

  private extractRowVersionText(res: any): string | null {
    if (!res) return null;
    const entities = Array.isArray(res.entities) ? res.entities : [];
    for (const e of entities) {
      if (e && e.name === "StyleCosting" && e.column && (e.column.RowVersionText || e.column.rowVersionText)) {
        return String(e.column.RowVersionText || e.column.rowVersionText);
      }
    }
    // Bazı response yapılarında doğrudan kolon olmayabilir; fallback olarak ara.
    return this.deepFindRowVersion(res);
  }

  private deepFindRowVersion(obj: any): string | null {
    if (!obj || typeof obj !== "object") return null;
    if (obj.RowVersionText) return String(obj.RowVersionText);
    if (obj.rowVersionText) return String(obj.rowVersionText);
    if (Array.isArray(obj)) {
      for (const it of obj) {
        const v = this.deepFindRowVersion(it);
        if (v) return v;
      }
    } else {
      for (const k of Object.keys(obj)) {
        const v = this.deepFindRowVersion(obj[k]);
        if (v) return v;
      }
    }
    return null;
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

function esc(s: string): string { return s.replace(/"/g, "&quot;"); }

export const widgetFactory = (context: IWidgetContext): IWidgetInstance => new CostMissingWidget(context);
