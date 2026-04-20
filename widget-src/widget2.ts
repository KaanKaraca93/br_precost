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
  private season:      string = "";
  private brands:      string[] = [];
  private categories:  string[] = [];
  private results:     ResultRow[] = [];
  private bulkConfigs: BulkConfig[] = [];
  private loading:     boolean = false;
  private toastTimer:  any = null;

  // multi-select popover state
  private openPicker:  string | null = null;

  constructor(private widgetContext: IWidgetContext) {
    this.$el = widgetContext.getElement();
    this.renderShell();
    this.bindAll();
    this.fetchLookup();
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
    this.populatePickers();
  }

  // ── Multi-select pickers ───────────────────────────────────────────────────

  private populatePickers(): void {
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
      return `<label style="display:flex;align-items:center;gap:8px;padding:5px 10px;cursor:pointer;border-radius:4px;font-size:12px;" onmouseover="this.style.background='#f1f3f5'" onmouseout="this.style.background='transparent'">
        <input type="${inputType}" name="cm-pick-${key}" value="${esc(v.name)}" ${checked ? "checked" : ""} style="margin:0;cursor:pointer;" />
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
          <span style="font-size:14px;font-weight:600;">Maliyeti Eksik Modeller — Ana Kumaş</span>
          <span style="display:flex;align-items:center;gap:8px;">
            <span id="cm-cache-info" style="font-size:11px;color:rgba(255,255,255,.85);"></span>
            <span style="background:rgba(255,255,255,.2);padding:2px 8px;border-radius:10px;font-size:11px;">PreCost v1</span>
          </span>
        </div>

        <div style="padding:12px 16px;">

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
        </div>

        <div id="cm-toast" style="position:absolute;bottom:18px;right:18px;padding:10px 18px;border-radius:6px;font-size:13px;font-weight:600;color:white;box-shadow:0 4px 16px rgba(0,0,0,.2);opacity:0;transition:opacity .25s;z-index:1000;pointer-events:none;"></div>
      </div>
    `);
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
      `StyleBOM($select=Id,Name;$expand=BOMLine($select=Code,Name,Composition,Weight,UserDefinedField12,PurchasePrice,CurrencyId,Quantity;$filter=IsMainLine eq true)),` +
      `StyleCosting($select=Id)`;

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
      // Sadece ana kumaş quantity null/0 olanları al
      const bom = s.StyleBOM && s.StyleBOM[0];
      const line = bom && bom.BOMLine && bom.BOMLine[0];
      if (!line) continue;
      const qty = line.Quantity !== undefined && line.Quantity !== null ? parseFloat(line.Quantity) : null;
      if (qty !== null && qty > 0) continue;

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

      // Kumaş eni
      const widthCm = this.resolveFabricWidth(line.UserDefinedField12);
      const adjusted = (baseSuggestion !== null && widthCm !== null)
        ? this.adjustForWidth(baseSuggestion, widthCm)
        : baseSuggestion;

      out.push({
        styleId:       s.StyleId,
        styleCode:     s.StyleCode || "",
        name:          s.Name || "",
        brand:         brandName,
        category:      catName,
        bomLine:       line,
        currentQty:    qty,
        fabricCode:    line.Code || "",
        fabricWidthCm: widthCm,
        combo:         combo,
        comboReadable: Object.keys(combo).length === 0 ? "—" : Object.entries(combo).map(([k, v]) => `${k}: ${v}`).join(", "),
        matchStatus:   matchStatus,
        baseSuggestion,
        adjustedSuggestion: adjusted,
        reason,
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
      this.setMain(this.emptyState("✅", "Seçili kriterlere uygun, ana kumaş sarfı eksik model bulunamadı"));
      return;
    }

    const matchCounts = {
      match:     this.results.filter(r => r.matchStatus === "match").length,
      partial:   this.results.filter(r => r.matchStatus === "partial").length,
      none:      this.results.filter(r => r.matchStatus === "none").length,
      noConfig:  this.results.filter(r => r.matchStatus === "no-config").length,
    };

    const TH = "text-align:left;padding:7px 10px;background:#f1f3f5;border-bottom:2px solid #e9ecef;font-size:11px;font-weight:700;color:#6c757d;text-transform:uppercase;white-space:nowrap;";
    const TD = "padding:7px 10px;border-bottom:1px solid #f1f3f5;vertical-align:top;font-size:12px;";

    const rows = this.results.map(r => {
      const status = this.statusBadge(r.matchStatus);
      const widthTxt = r.fabricWidthCm !== null ? `${r.fabricWidthCm} cm` : `<span style="color:#adb5bd;">?</span>`;
      const baseTxt = r.baseSuggestion !== null ? `${r.baseSuggestion.toFixed(3)} m` : "—";
      const adjTxt  = r.adjustedSuggestion !== null
        ? `<strong style="color:#1D5FA3;">${r.adjustedSuggestion.toFixed(3)} m</strong>`
        : `<span style="color:#adb5bd;">—</span>`;
      const qtyTxt = r.currentQty === null
        ? `<span style="color:#c62828;font-weight:600;">null</span>`
        : `<span style="color:#c62828;font-weight:600;">${r.currentQty}</span>`;

      return `<tr>
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
        <td style="${TD}">${status}<div style="font-size:10px;color:#6c757d;margin-top:2px;">${r.reason}</div></td>
      </tr>`;
    }).join("");

    this.setMain(`
      <div style="background:white;border:1px solid #e9ecef;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.08);">
        <div style="padding:10px 16px;border-bottom:1px solid #e9ecef;display:flex;align-items:center;flex-wrap:wrap;gap:8px;">
          <span style="font-weight:700;">Sonuçlar (${this.results.length})</span>
          <span style="background:#e8f5e9;color:#2e7d32;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">${matchCounts.match} eşleşti</span>
          <span style="background:#fff3e0;color:#e65100;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">${matchCounts.partial} kısmi</span>
          <span style="background:#ffebee;color:#c62828;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">${matchCounts.noConfig} parametresiz</span>
          <span style="background:#f1f3f5;color:#6c757d;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;margin-left:auto;">Düzeltme: 150cm baz, her 2cm = ±0.01m</span>
        </div>
        <div style="overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;">
            <thead><tr>
              <th style="${TH}">Style</th>
              <th style="${TH}">Marka</th>
              <th style="${TH}">Kategori</th>
              <th style="${TH};text-align:right;">Mevcut Sarf</th>
              <th style="${TH}">Kumaş</th>
              <th style="${TH}">Kombinasyon</th>
              <th style="${TH};text-align:right;">Baz Öneri (150cm)</th>
              <th style="${TH};text-align:right;">Düzeltilmiş</th>
              <th style="${TH}">Eşleşme</th>
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
}

// ── Utilities ────────────────────────────────────────────────────────────────

function esc(s: string): string { return s.replace(/"/g, "&quot;"); }

export const widgetFactory = (context: IWidgetContext): IWidgetInstance => new CostMissingWidget(context);
