import { IWidgetContext, IWidgetInstance, Log } from "lime";

declare var $: JQueryStatic;

// ION Gateway üzerinden Heroku backend
const API_BASE = "/CustomerApi/brprecostparams";

// Selector GlRefId'leri — dropdown için (Sezon/Marka/Kategori)
const SELECTOR_MAP: { [id: number]: string } = {
  1:  "Marka",
  51: "Kategori",
  58: "Sezon",
};

// Cost-attr GlRefId'leri (standart) — parametre seçim ekranı için
const STANDARD_COST_MAP: { [id: number]: string } = {
  72:  "Fit Bilgisi",
  73:  "Astar Tipi",
  74:  "Yaka Tipi",
  75:  "Cep Tipi",
  103: "Desen Tipi",
  232: "Yırtmaç Tipi",
  233: "Kol Tipi",
  234: "Kumaş Tipi",
};

// Reference GlRefId'leri — UI'da gösterilmez, sadece cache'lenir (Widget 2 kullanır)
const REFERENCE_MAP: { [id: number]: string } = {
  197: "Kumaş Eni",   // BomLine.UserDefinedField12 → cm değeri (Code alanından okunur)
};

// Maliyet kategorileri — şimdilik "ana-kumash" ve "iscilik" implementasyonlu
interface CostCategory {
  key:    string;
  icon:   string;
  title:  string;
  desc:   string;
  status: "ready" | "wip";
  unit:   string;                 // tablo ve hint için: "m" / "TL"
  unitLabel: string;              // kolon başlığı: "Sarf (m)" / "Tutar (TL)"
  hint:   string;                 // mavi info banner metni
  allowZeroAttrs: boolean;        // true ise parametre seçmeden tek değer girilebilir
  endpointBase: string;           // "/api/ana-kumash" veya "/api/cost-params/<key>"
  zeroAttrsRowLabel?: string;     // 0 attr modunda tek satırın açıklama metni
}
const COST_CATEGORIES: CostCategory[] = [
  {
    key: "ana-kumash", icon: "🧵", title: "Ana Kumaş Sarf",
    desc: "Sezon/marka/kategori bazlı ana kumaş sarf parametreleri",
    status: "ready", unit: "m", unitLabel: "Sarf (m)",
    hint: "ℹ️ Değerler <strong>150 cm kumaş eni</strong> baz alınarak girilmelidir",
    allowZeroAttrs: false,
    endpointBase: "/api/ana-kumash",
  },
  {
    key: "iscilik", icon: "👷", title: "İşçilik",
    desc: "İşçilik maliyet bileşenleri (parametre seçimi opsiyonel)",
    status: "ready", unit: "TL", unitLabel: "Tutar (TL)",
    hint: "ℹ️ Tutarlar <strong>TL</strong> cinsindendir. Parametre seçmeden de doğrudan kategoriye fiyat girebilirsiniz.",
    allowZeroAttrs: true,
    endpointBase: "/api/cost-params/iscilik",
    zeroAttrsRowLabel: "Bu marka × kategori için sabit işçilik",
  },
  { key: "uretim-paket", icon: "📦", title: "Üretim & Paketleme",   desc: "Üretim ve paketleme maliyetleri",       status: "wip", unit: "TL", unitLabel: "Tutar (TL)", hint: "", allowZeroAttrs: true,  endpointBase: "/api/cost-params/uretim-paket" },
];

function getCategory(key: string | null): CostCategory | null {
  if (!key) return null;
  return COST_CATEGORIES.find(c => c.key === key) || null;
}

interface AttributeMap     { [name: string]: string[] }
interface AttrCombo        { [name: string]: string }
interface MatrixRow        { combo: AttrCombo; consumption: number | null; savedValue: number | null }
interface ConsumptionValue { attrCombo: AttrCombo; consumption: number | null; unit: string }

class AnaKumashWidget implements IWidgetInstance {
  private $el: JQuery;

  private allAttrs:      AttributeMap = {};
  private selectorData:  { [key: string]: string[] } = {};
  private selectedAttrs: string[]     = [];
  private originalAttrs: string[]     = [];
  private matrixRows:    MatrixRow[]  = [];
  private colFilters:    { [attr: string]: string } = {};
  private statusFilter:  string = "";
  private lastRefreshedAt: string | null = null;
  private refreshing:    boolean = false;
  private currentCategory: string | null = null;

  private season        = "";
  private brand         = "";
  private styleCategory = "";
  private dirty         = false;
  private toastTimer:   any = null;
  private confirmOk:    (() => void) | null = null;

  constructor(private widgetContext: IWidgetContext) {
    this.$el = widgetContext.getElement();
    this.renderShell();
    this.bindAll();
    this.fetchAttributes();
    this.renderCategoryPicker();
  }

  settingsSaved(): void {}

  dispose(): void { this.$el.off(); }

  // ── Bootstrap — önce Heroku cache, stale ise arka planda PLM refresh ─────

  private fetchAttributes(): void {
    this.apiGet("/api/lookup/all",
      (data: any) => {
        this.applyLookupData(data);
        if (data && data.stale) {
          Log.debug("[PreCost] Cache stale → background refresh from PLM");
          this.refreshLookupFromPLM(/* silent */ true);
        }
      },
      (err: any) => {
        Log.error("[PreCost] /api/lookup/all error: " + JSON.stringify(err));
        // Cache hiç yoksa kullanıcı için ilk kez PLM'den çek
        this.refreshLookupFromPLM(/* silent */ false);
      }
    );
  }

  private applyLookupData(data: any): void {
    const attrs: any[] = (data && data.attributes) ? data.attributes : [];

    this.selectorData = {};
    const costAttrs: AttributeMap = {};

    for (const a of attrs) {
      const names = (a.values || []).map((v: any) => v.name).filter((n: string) => !!n);
      if (a.role === "selector")  this.selectorData[a.label] = names;
      if (a.role === "cost-attr") costAttrs[a.label] = names;
    }

    this.allAttrs        = costAttrs;
    this.lastRefreshedAt = data ? data.lastRefreshedAt : null;
    this.populateSelectors();
  }

  private populateSelectors(): void {
    const hint = this.lastRefreshedAt
      ? `Son güncelleme: ${this.formatAge(this.lastRefreshedAt)}`
      : "İlk yükleme yapılıyor…";
    this.$el.find("#ak-cache-info").text(hint);

    // Selector'lar sadece Ana Kumaş ekranındayken DOM'da var
    const cat = getCategory(this.currentCategory);
    if (!cat || cat.status !== "ready") return;
    if (this.$el.find("#ak-season").length === 0) return;

    const mkOpts = (items: string[]) =>
      '<option value="">Seçiniz</option>' +
      items.map(v => `<option value="${esc(v)}">${v}</option>`).join("");

    this.$el.find("#ak-season").html(mkOpts(this.selectorData["Sezon"]    || [])).prop("disabled", false).css("opacity", "1");
    this.$el.find("#ak-brand") .html(mkOpts(this.selectorData["Marka"]    || [])).prop("disabled", false).css("opacity", "1");
    this.$el.find("#ak-cat")   .html(mkOpts(this.selectorData["Kategori"] || [])).prop("disabled", false).css("opacity", "1");
    this.$el.find("#ak-load")  .prop("disabled", false).css("opacity", "1");

    if (this.$el.find("#ak-main").children().length === 0 ||
        this.$el.find("#ak-main").text().indexOf("yükleniyor") !== -1) {
      this.setMain(this.emptyState("🔍", "Sezon, marka ve kategori seçip <strong>Yükle</strong>'ye basın"));
    }
  }

  // ── PLM'den 3 çağrı + Heroku'ya POST ─────────────────────────────────────

  private refreshLookupFromPLM(silent: boolean): void {
    if (this.refreshing) return;
    this.refreshing = true;
    if (!silent) this.toast("PLM değer listeleri yenileniyor…", "info");

    const PLM_LOOKUP   = "/FASHIONPLM/odata2/api/odata2/GenericLookUpAll/GetAllLookups";
    const PLM_EXT_DEF  = "/FASHIONPLM/odata2/api/odata2/STYLEEXTENDEDFIELDS";
    const PLM_EXT_DROP = "/FASHIONPLM/odata2/api/odata2/EXTENDEDFIELDDROPDOWN";

    this.ionGet(PLM_LOOKUP, (lookupRes: any) => {
      this.ionGet(PLM_EXT_DEF, (extDefRes: any) => {
        this.ionGet(PLM_EXT_DROP, (extDropRes: any) => {
          try {
            const payload = this.buildRefreshPayload(
              (lookupRes  && lookupRes.value)  || [],
              (extDefRes  && extDefRes.value)  || [],
              (extDropRes && extDropRes.value) || []
            );
            this.apiPost("/api/lookup/refresh", payload, (resp: any) => {
              this.refreshing = false;
              this.lastRefreshedAt = resp ? resp.lastRefreshedAt : new Date().toISOString();
              this.apiGet("/api/lookup/all",
                (data: any) => {
                  this.applyLookupData(data);
                  this.toast(silent ? "Değer listeleri arka planda güncellendi" : "Değer listeleri güncellendi ✓", "success");
                },
                (e: any) => Log.error("[PreCost] /api/lookup/all reload error: " + JSON.stringify(e))
              );
            }, (err: any) => {
              this.refreshing = false;
              Log.error("[PreCost] /api/lookup/refresh error: " + JSON.stringify(err));
              if (!silent) this.toast("Cache yenilenemedi", "error");
            });
          } catch (e: any) {
            this.refreshing = false;
            Log.error("[PreCost] PLM payload build error: " + (e && e.message ? e.message : e));
          }
        }, (err: any) => this.plmFail(err, silent, "EXTENDEDFIELDDROPDOWN"));
      }, (err: any) => this.plmFail(err, silent, "STYLEEXTENDEDFIELDS"));
    }, (err: any) => this.plmFail(err, silent, "GenericLookUpAll"));
  }

  private plmFail(err: any, silent: boolean, label: string): void {
    this.refreshing = false;
    Log.error("[PreCost] PLM " + label + " error: " + JSON.stringify(err));
    if (!silent) this.toast("PLM " + label + " çağrısı başarısız", "error");
  }

  private buildRefreshPayload(lookupItems: any[], extDefItems: any[], extDropItems: any[]) {
    // 1) Selectors (Sezon/Marka/Kategori)
    const selectors = Object.keys(SELECTOR_MAP).map(idStr => {
      const id    = parseInt(idStr, 10);
      const label = SELECTOR_MAP[id];
      const values = lookupItems
        .filter(it => it.GlrefId === id && it.Status === 1 && it.Name)
        .sort((a, b) => (a.sequence || 0) - (b.sequence || 0))
        .map(it => ({ id: String(it.GlValId), name: String(it.Name).trim(), code: it.Code || null, seq: it.sequence || 0 }));
      return { key: label, sourceId: String(id), values };
    });

    // 2) Standart cost-attrs
    const standardCost = Object.keys(STANDARD_COST_MAP).map(idStr => {
      const id    = parseInt(idStr, 10);
      const label = STANDARD_COST_MAP[id];
      const values = lookupItems
        .filter(it => it.GlrefId === id && it.Status === 1 && it.Name)
        .sort((a, b) => (a.sequence || 0) - (b.sequence || 0))
        .map(it => ({ id: String(it.GlValId), name: String(it.Name).trim(), code: it.Code || null, seq: it.sequence || 0 }));
      return { key: label, source: "standard", sourceId: String(id), values };
    });

    // 3) Extended cost-attrs (FieldType=4)
    const extDropByFld: { [extFldId: string]: any[] } = {};
    for (const d of extDropItems) {
      if (d.Status !== 1 || !d.Name) continue;
      const k = d.ExtFldId;
      if (!extDropByFld[k]) extDropByFld[k] = [];
      extDropByFld[k].push({ id: String(d.ExtFldDropDownId), name: String(d.Name).trim(), code: d.Code || null, seq: d.Seq || 0 });
    }

    const extendedCost = extDefItems
      .filter(f => f.FieldType === 4 && f.ExtFldId && (f.CustomLabel || f.Name))
      .map(f => {
        const label  = String(f.CustomLabel || f.Name).trim();
        const values = (extDropByFld[f.ExtFldId] || []).sort((a, b) => a.seq - b.seq);
        return { key: label, source: "extended", sourceId: String(f.ExtFldId), values };
      })
      .filter(e => e.values.length > 0); // Boş dropdown'ları gönderme

    // 4) Reference (yalnızca cache, UI'da gösterilmez)
    const references = Object.keys(REFERENCE_MAP).map(idStr => {
      const id    = parseInt(idStr, 10);
      const label = REFERENCE_MAP[id];
      const values = lookupItems
        .filter(it => it.GlrefId === id && it.Status === 1 && it.Name)
        .sort((a, b) => (a.sequence || 0) - (b.sequence || 0))
        .map(it => ({ id: String(it.GlValId), name: String(it.Name).trim(), code: it.Code || null, seq: it.sequence || 0 }));
      return { key: label, source: "standard", sourceId: String(id), values };
    });

    return { selectors, costAttrs: [...standardCost, ...extendedCost], references };
  }

  private formatAge(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    const min = Math.floor(ms / 60000);
    if (min < 1)    return "az önce";
    if (min < 60)   return min + " dakika önce";
    const h = Math.floor(min / 60);
    if (h < 24)     return h + " saat önce";
    const d = Math.floor(h / 24);
    return d + " gün önce";
  }

  // ── One-time event binding ─────────────────────────────────────────────────

  private bindAll(): void {
    // Kategori seçici
    this.$el.on("click", "[data-cat]", (e: JQueryEventObject) => {
      const key = $(e.currentTarget).attr("data-cat") as string;
      this.enterCategory(key);
    });
    this.$el.on("click", "#ak-back-home, #ak-back-home2", () => this.attemptBackHome());

    // Selector bar
    this.$el.on("click", "#ak-load", () => this.loadCombination());

    // Step 1
    this.$el.on("click", "[data-attr]",      (e: JQueryEventObject) => this.toggleAttr($(e.currentTarget).attr("data-attr") as string));
    this.$el.on("click", "#ak-to-matrix",   () => this.goToMatrix());

    // Step 2
    this.$el.on("input",  "[data-row]",     (e: JQueryEventObject) => this.onInput(e));
    this.$el.on("click",  "#ak-back",       () => this.backToAttrs());
    this.$el.on("click",  "#ak-save",       () => this.saveValues());
    this.$el.on("change", "[data-filter]",  (e: JQueryEventObject) => this.onFilterChange(e));
    this.$el.on("click",  "#ak-clear-filt", () => this.clearFilters());

    // Custom confirm modal
    this.$el.on("click", "#ak-modal-ok",    () => { this.hideModal(); if (this.confirmOk) this.confirmOk(); });
    this.$el.on("click", "#ak-modal-cancel",() => this.hideModal());
  }

  // ── Shell ─────────────────────────────────────────────────────────────────

  private renderShell(): void {
    this.$el.html(`
      <div style="font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#343a40;background:#f8f9fa;min-height:400px;position:relative;">

        <div style="background:#1D5FA3;color:white;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;gap:10px;">
          <span id="ak-title" style="font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px;">PreCost — Maliyet Parametre Yönetimi</span>
          <span style="display:flex;align-items:center;gap:8px;">
            <span id="ak-cache-info" style="font-size:11px;color:rgba(255,255,255,.85);"></span>
            <span style="background:rgba(255,255,255,.2);padding:2px 8px;border-radius:10px;font-size:11px;">PreCost v1</span>
          </span>
        </div>

        <div id="ak-content" style="padding:12px 16px;"></div>

        <!-- Custom confirm modal -->
        <div id="ak-modal" style="display:none;position:absolute;inset:0;background:rgba(0,0,0,.45);z-index:999;align-items:center;justify-content:center;">
          <div style="background:white;border-radius:8px;padding:20px 24px;width:380px;max-width:90%;box-shadow:0 8px 32px rgba(0,0,0,.2);">
            <div id="ak-modal-msg" style="font-size:13px;color:#343a40;margin-bottom:18px;line-height:1.6;"></div>
            <div style="display:flex;gap:8px;justify-content:flex-end;">
              <button id="ak-modal-cancel" style="padding:7px 14px;background:#f1f3f5;border:1px solid #e9ecef;border-radius:6px;font-size:13px;cursor:pointer;">İptal</button>
              <button id="ak-modal-ok"     style="padding:7px 18px;background:#c62828;color:white;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;">Devam</button>
            </div>
          </div>
        </div>

        <div id="ak-toast" style="position:absolute;bottom:18px;right:18px;padding:10px 18px;border-radius:6px;font-size:13px;font-weight:600;color:white;box-shadow:0 4px 16px rgba(0,0,0,.2);opacity:0;transition:opacity .25s;z-index:1000;pointer-events:none;"></div>
      </div>
    `);
  }

  // ── Kategori seçici (landing) ─────────────────────────────────────────────

  private renderCategoryPicker(): void {
    this.currentCategory = null;
    this.$el.find("#ak-title").html("PreCost — Maliyet Parametre Yönetimi");

    const cards = COST_CATEGORIES.map(c => {
      const ready = c.status === "ready";
      const badge = ready
        ? `<span style="background:#e8f5e9;color:#2e7d32;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">Hazır</span>`
        : `<span style="background:#fff3e0;color:#e65100;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;">Yapım Aşamasında</span>`;
      const cursor  = ready ? "pointer" : "not-allowed";
      const opacity = ready ? "1" : ".55";
      const hover   = ready ? "border-color:#1D5FA3;" : "";
      return `<div data-cat="${esc(c.key)}" style="background:white;border:2px solid #e9ecef;border-radius:8px;padding:16px;cursor:${cursor};opacity:${opacity};box-shadow:0 1px 4px rgba(0,0,0,.06);transition:border-color .15s;" onmouseover="this.style.borderColor='${ready ? "#1D5FA3" : "#e9ecef"}'" onmouseout="this.style.borderColor='#e9ecef'">
        <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:8px;">
          <div style="font-size:28px;line-height:1;">${c.icon}</div>
          <div style="flex:1;">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
              <span style="font-size:14px;font-weight:700;color:#343a40;">${c.title}</span>
              ${badge}
            </div>
            <div style="font-size:12px;color:#6c757d;line-height:1.4;">${c.desc}</div>
          </div>
        </div>
      </div>`;
    }).join("");

    this.setContent(`
      <div style="margin-bottom:14px;">
        <div style="font-size:13px;color:#6c757d;">İşlem yapmak istediğiniz maliyet kategorisini seçin</div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;">${cards}</div>
    `);
  }

  private enterCategory(key: string): void {
    const cat = COST_CATEGORIES.find(c => c.key === key);
    if (!cat) return;
    if (cat.status !== "ready") {
      this.renderUnderConstruction(cat);
      return;
    }
    this.currentCategory = key;
    this.renderCategoryShell(cat);
  }

  private renderUnderConstruction(cat: CostCategory): void {
    this.currentCategory = cat.key;
    this.$el.find("#ak-title").html(`<button id="ak-back-home" style="background:rgba(255,255,255,.15);color:white;border:none;border-radius:4px;padding:3px 9px;font-size:12px;cursor:pointer;">← Kategoriler</button> <span style="opacity:.7;">/</span> ${cat.title}`);
    this.setContent(`
      <div style="background:white;border:1px dashed #e0e0e0;border-radius:8px;padding:60px 20px;text-align:center;">
        <div style="font-size:48px;margin-bottom:12px;">${cat.icon}</div>
        <div style="font-size:16px;font-weight:700;color:#343a40;margin-bottom:6px;">${cat.title}</div>
        <div style="font-size:13px;color:#6c757d;margin-bottom:18px;">${cat.desc}</div>
        <div style="display:inline-block;background:#fff3e0;color:#e65100;padding:8px 18px;border-radius:20px;font-size:13px;font-weight:600;">🚧 Yapım aşamasında</div>
        <div style="margin-top:24px;">
          <button id="ak-back-home2" style="padding:7px 16px;background:#1D5FA3;color:white;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;">← Kategori Seçimine Dön</button>
        </div>
      </div>
    `);
  }

  // Geriye dönük uyumluluk için bırakıldı
  private renderAnaKumashShell(): void {
    const cat = getCategory("ana-kumash");
    if (cat) this.renderCategoryShell(cat);
  }

  private renderCategoryShell(cat: CostCategory): void {
    const loading = '<option value="">Yükleniyor…</option>';
    const sezOpts = this.optsHtml(this.selectorData["Sezon"]    || []);
    const mrkOpts = this.optsHtml(this.selectorData["Marka"]    || []);
    const katOpts = this.optsHtml(this.selectorData["Kategori"] || []);
    const isLoading = (this.selectorData["Sezon"] || []).length === 0;

    this.$el.find("#ak-title").html(`<button id="ak-back-home" style="background:rgba(255,255,255,.15);color:white;border:none;border-radius:4px;padding:3px 9px;font-size:12px;cursor:pointer;">← Kategoriler</button> <span style="opacity:.7;">/</span> ${cat.icon} ${cat.title}`);

    this.setContent(`
      <div style="background:white;border:1px solid #e9ecef;border-radius:6px;padding:10px 14px;margin-bottom:14px;display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;box-shadow:0 1px 4px rgba(0,0,0,.08);">
        ${this.selGroup("Sezon",    "ak-season", isLoading ? loading : sezOpts, isLoading)}
        ${this.selGroup("Marka",    "ak-brand",  isLoading ? loading : mrkOpts, isLoading)}
        ${this.selGroup("Kategori", "ak-cat",    isLoading ? loading : katOpts, isLoading)}
        <button id="ak-load" ${isLoading ? "disabled" : ""} style="padding:7px 16px;background:#1D5FA3;color:white;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;${isLoading ? "opacity:.5;" : ""}">Yükle</button>
      </div>
      <div id="ak-main">${isLoading
        ? this.emptyState("⏳", "PLM değer listeleri yükleniyor…")
        : this.emptyState("🔍", "Sezon, marka ve kategori seçip <strong>Yükle</strong>'ye basın")}</div>
    `);
  }

  private optsHtml(items: string[]): string {
    return '<option value="">Seçiniz</option>' +
      items.map(v => `<option value="${esc(v)}">${v}</option>`).join("");
  }

  private setContent(html: string): void { this.$el.find("#ak-content").html(html); }

  // Tüm selector'lar artık <select> — inner: option HTML, disabled: PLM yüklenene kadar
  private selGroup(label: string, id: string, inner: string, disabled = false): string {
    const lbl   = `<label style="font-size:11px;font-weight:600;color:#6c757d;text-transform:uppercase;letter-spacing:.4px;">${label}</label>`;
    const style = "padding:6px 10px;border:1px solid #e9ecef;border-radius:6px;font-size:13px;min-width:140px;outline:none;" + (disabled ? "opacity:.6;" : "");
    const dis   = disabled ? " disabled" : "";
    const el    = `<select id="${id}"${dis} style="${style}">${inner}</select>`;
    return `<div style="display:flex;flex-direction:column;gap:4px;">${lbl}${el}</div>`;
  }

  // ── Modal helpers ─────────────────────────────────────────────────────────

  private showConfirm(msg: string, onOk: () => void): void {
    this.confirmOk = onOk;
    this.$el.find("#ak-modal-msg").html(msg.replace(/\n/g, "<br>"));
    this.$el.find("#ak-modal").css("display", "flex");
  }

  private hideModal(): void {
    this.$el.find("#ak-modal").css("display", "none");
    this.confirmOk = null;
  }

  // ── Load combination ──────────────────────────────────────────────────────

  private loadCombination(): void {
    this.season        = ((this.$el.find("#ak-season").val() as string) || "").trim();
    this.brand         = ((this.$el.find("#ak-brand").val()  as string) || "").trim();
    this.styleCategory = ((this.$el.find("#ak-cat").val()    as string) || "").trim();

    if (!this.season || !this.brand || !this.styleCategory) {
      this.toast("Sezon, marka ve kategori zorunlu", "error"); return;
    }

    this.colFilters   = {};
    this.statusFilter = "";
    this.setMain(this.emptyState("⏳", "Yükleniyor…"));

    const cfgPath = this.combo("config");
    const valPath = this.combo("values");

    this.apiGet(cfgPath, (cfg: { selectedAttrs: string[] }) => {
      this.selectedAttrs = cfg.selectedAttrs || [];
      this.originalAttrs = [...this.selectedAttrs];

      this.apiGet(valPath, (vals: ConsumptionValue[]) => {
        // Önce attribute seçim ekranını göster — kullanıcı ekleme/değiştirme yapabilsin.
        // Daha önce kayıtlı attribute set'i varsa (veya allowZeroAttrs ile boş seçim onaylanmışsa)
        // direkt matrix'e atlayıp orada yarat. Şimdilik akışı bozmamak için:
        //  - Daha önce kaydedilmiş attribute varsa (>=1) → matrix
        //  - Yoksa → her zaman attribute seçim ekranı (0 attr da burada onaylanır)
        if (this.selectedAttrs.length > 0) {
          this.buildMatrixRows(vals);
          this.renderMatrix();
        } else {
          // Daha önce 0 attr ile kaydedilmiş değer varsa direkt matrix moduna geç
          const cat = getCategory(this.currentCategory);
          if (cat && cat.allowZeroAttrs && vals && vals.length > 0) {
            this.buildMatrixRows(vals);
            this.renderMatrix();
          } else {
            this.renderAttrSelect();
          }
        }
      }, (err: any) => Log.error("[PreCost] Values: " + JSON.stringify(err)));

    }, (err: any) => {
      this.setMain(this.emptyState("⚠️", "API hatası: " + JSON.stringify(err)));
    });
  }

  // ── Step 1 ────────────────────────────────────────────────────────────────

  private renderAttrSelect(): void {
    const cards = Object.entries(this.allAttrs).map(([name, values]) => {
      const sel   = this.selectedAttrs.includes(name);
      const bdr   = sel ? "#1D5FA3" : "#e9ecef";
      const bg    = sel ? "#e8f0fa" : "white";
      const check = sel ? `<div style="width:16px;height:16px;border-radius:4px;background:#1D5FA3;border:2px solid #1D5FA3;color:white;font-size:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">✓</div>`
                        : `<div style="width:16px;height:16px;border-radius:4px;border:2px solid #adb5bd;flex-shrink:0;"></div>`;
      const chips = values.map(v =>
        `<span style="background:${sel?"white":"#f1f3f5"};color:${sel?"#1D5FA3":"#6c757d"};padding:2px 7px;border-radius:10px;font-size:11px;margin:2px 2px 0 0;display:inline-block;">${v}</span>`
      ).join("");

      return `<div data-attr="${esc(name)}" style="border:2px solid ${bdr};background:${bg};border-radius:6px;padding:10px 12px;cursor:pointer;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">${check}<span style="font-weight:700;">${name}</span><span style="font-size:11px;color:#6c757d;margin-left:auto;">${values.length} değer</span></div>
        <div>${chips}</div>
      </div>`;
    }).join("");

    const cat = getCategory(this.currentCategory);
    const count   = this.selectedAttrs.reduce((acc, a) => acc * (this.allAttrs[a]?.length || 1), 1);
    let preview = "";
    if (this.selectedAttrs.length > 0) {
      preview = `<div style="margin-top:10px;padding:8px 12px;background:#e8f5e9;border-radius:6px;font-size:12px;color:#2e7d32;">✓ Matris boyutu: ${this.selectedAttrs.map(a => this.allAttrs[a].length).join(" × ")} = <strong>${count} kombinasyon</strong></div>`;
    } else if (cat && cat.allowZeroAttrs) {
      preview = `<div style="margin-top:10px;padding:8px 12px;background:#fff3e0;border-radius:6px;font-size:12px;color:#e65100;">ℹ️ Parametre seçmeden devam ederseniz bu marka × kategori için <strong>tek bir ${cat.unit} değeri</strong> girersiniz.</div>`;
    }

    const helperText = cat && cat.allowZeroAttrs
      ? "Maliyeti hangi özellikler belirliyor? (Boş bırakılabilir)"
      : "Maliyeti hangi özellikler belirliyor?";

    this.setMain(`
      ${this.ctxBar(1)}
      <div style="background:white;border:1px solid #e9ecef;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.08);">
        <div style="padding:10px 16px;border-bottom:1px solid #e9ecef;display:flex;align-items:center;gap:8px;">
          <span style="font-weight:700;">Etken Parametreleri Seçin</span>
          <span style="font-size:11px;color:#6c757d;margin-left:auto;">${helperText}</span>
        </div>
        <div style="padding:14px;">
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;">${cards}</div>
          ${preview}
          <div style="margin-top:14px;">
            <button id="ak-to-matrix" style="padding:7px 16px;background:#1D5FA3;color:white;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;">Devam →</button>
          </div>
        </div>
      </div>`);
  }

  private toggleAttr(name: string): void {
    const idx = this.selectedAttrs.indexOf(name);
    if (idx === -1) this.selectedAttrs.push(name); else this.selectedAttrs.splice(idx, 1);
    this.renderAttrSelect();
  }

  // ── Step 1 → Step 2 ───────────────────────────────────────────────────────

  private goToMatrix(): void {
    const cat = getCategory(this.currentCategory);
    if (this.selectedAttrs.length === 0 && !(cat && cat.allowZeroAttrs)) {
      this.toast("En az bir parametre seçin", "error"); return;
    }

    const changed = sortedKey(this.selectedAttrs) !== sortedKey(this.originalAttrs);
    if (changed && this.originalAttrs.length > 0) {
      this.showConfirm(
        "Parametre seçimi değiştirildi.\nBu kombinasyona ait tüm kayıtlı değerler silinecek.\n\nDevam etmek istiyor musunuz?",
        () => this.doGoToMatrix()
      );
      return;
    }
    this.doGoToMatrix();
  }

  private doGoToMatrix(): void {
    this.apiPost(this.combo("config"), { selectedAttrs: this.selectedAttrs }, (res: { valuesReset?: boolean }) => {
      this.originalAttrs = [...this.selectedAttrs];
      this.apiGet(this.combo("values"), (vals: ConsumptionValue[]) => {
        this.buildMatrixRows(vals);
        this.dirty = false;
        this.renderMatrix();
        if (res.valuesReset) this.toast("Parametre listesi değişti — eski değerler temizlendi", "info");
      }, (err: any) => Log.error("[PreCost] Values: " + JSON.stringify(err)));
    }, (_err: any) => this.toast("Config kaydetme hatası", "error"));
  }

  // ── Step 2 ────────────────────────────────────────────────────────────────

  private buildMatrixRows(savedValues: ConsumptionValue[]): void {
    const map: { [k: string]: number | null } = {};
    for (const sv of savedValues) map[comboKey(sv.attrCombo)] = sv.consumption;

    if (this.selectedAttrs.length === 0) {
      // 0 attr modu: tek satır (attrCombo = {})
      const saved = map[comboKey({})] ?? null;
      this.matrixRows = [{ combo: {}, consumption: saved, savedValue: saved }];
      return;
    }

    const arrays = this.selectedAttrs.map(a => (this.allAttrs[a] || []).map(v => ({ attr: a, val: v })));
    const combos = cartesian(arrays);

    this.matrixRows = combos.map(combo => {
      const obj: AttrCombo = {};
      combo.forEach(({ attr, val }) => { obj[attr] = val; });
      const saved = map[comboKey(obj)] ?? null;
      return { combo: obj, consumption: saved, savedValue: saved };
    });
  }

  private renderMatrix(): void {
    const filledTotal = this.matrixRows.filter(r => r.consumption !== null).length;
    const total       = this.matrixRows.length;
    const pct         = total > 0 ? Math.round(filledTotal / total * 100) : 0;

    // Filtre uygula — orijinal index'i korumak için (input'lardaki data-row)
    const visible: { row: MatrixRow; idx: number }[] = [];
    this.matrixRows.forEach((r, idx) => {
      for (const a of this.selectedAttrs) {
        const f = this.colFilters[a];
        if (f && r.combo[a] !== f) return;
      }
      if (this.statusFilter) {
        const isEmpty   = r.consumption === null;
        const isSaved   = r.consumption !== null && r.consumption === r.savedValue;
        const isChanged = r.consumption !== null && r.consumption !== r.savedValue;
        if (this.statusFilter === "empty"   && !isEmpty)   return;
        if (this.statusFilter === "saved"   && !isSaved)   return;
        if (this.statusFilter === "changed" && !isChanged) return;
      }
      visible.push({ row: r, idx: idx });
    });

    const TH       = "text-align:left;padding:7px 10px;background:#f1f3f5;border-bottom:1px solid #e9ecef;font-size:11px;font-weight:700;color:#6c757d;text-transform:uppercase;white-space:nowrap;vertical-align:bottom;";
    const TD       = "padding:5px 10px;border-bottom:1px solid #f1f3f5;vertical-align:middle;";
    const FILT_BG  = "background:#fafbfc;border-bottom:2px solid #e9ecef;padding:5px 10px;";
    const SEL_STY  = "width:100%;padding:4px 6px;border:1px solid #e9ecef;border-radius:4px;font-size:12px;background:white;outline:none;";

    // Her attribute kolonu için filtre dropdown'u (sadece o kolondaki MEVCUT değerler)
    const filterCells = this.selectedAttrs.map(a => {
      const valuesInUse: { [v: string]: true } = {};
      this.matrixRows.forEach(r => { valuesInUse[r.combo[a]] = true; });
      const opts = Object.keys(valuesInUse).sort().map(v =>
        `<option value="${esc(v)}"${this.colFilters[a] === v ? " selected" : ""}>${v}</option>`
      ).join("");
      return `<th style="${FILT_BG}">
        <select data-filter="${esc(a)}" style="${SEL_STY}">
          <option value="">Tümü</option>${opts}
        </select>
      </th>`;
    }).join("");

    const sf = this.statusFilter;
    const statusFilterCell = `<th style="${FILT_BG}">
      <select data-filter="__status" style="${SEL_STY}">
        <option value=""        ${sf === ""        ? "selected" : ""}>Tümü</option>
        <option value="empty"   ${sf === "empty"   ? "selected" : ""}>Boş</option>
        <option value="saved"   ${sf === "saved"   ? "selected" : ""}>Kayıtlı</option>
        <option value="changed" ${sf === "changed" ? "selected" : ""}>Değişti</option>
      </select>
    </th>`;

    const cat = getCategory(this.currentCategory);
    const unit = cat ? cat.unit : "m";
    const inputMax = cat && cat.unit === "TL" ? "99999.99" : "99.999";
    const inputStep = cat && cat.unit === "TL" ? "0.01" : "0.001";

    const rows = visible.map(({ row: r, idx: i }) => {
      let cells: string;
      if (this.selectedAttrs.length === 0) {
        // 0 attr modu: tek bir açıklama hücresi
        const lbl = (cat && cat.zeroAttrsRowLabel) ? cat.zeroAttrsRowLabel : "Sabit değer";
        cells = `<td style="${TD};font-size:12px;color:#6c757d;font-style:italic;">${lbl}</td>`;
      } else {
        cells = this.selectedAttrs.map(a =>
          `<td style="${TD}"><span style="display:inline-block;background:#e8f0fa;color:#1D5FA3;padding:2px 8px;border-radius:10px;font-size:11px;">${r.combo[a]}</span></td>`
        ).join("");
      }
      const v   = r.consumption;
      const bg  = v !== null ? "#e8f5e9" : "white";
      const bdr = v !== null ? "#2e7d32" : "#e9ecef";
      return `<tr>
        ${cells}
        <td style="${TD}">
          <input type="number" step="${inputStep}" min="0" max="${inputMax}" data-row="${i}"
            value="${v !== null ? v : ""}" placeholder="0"
            style="width:110px;padding:5px 8px;border:1px solid ${bdr};border-radius:4px;font-size:13px;text-align:right;outline:none;background:${bg};" />
          <span style="font-size:11px;color:#6c757d;margin-left:3px;">${unit}</span>
        </td>
        <td id="ak-st-${i}" style="${TD}">${this.statusHtml(r)}</td>
      </tr>`;
    }).join("");

    const activeFilters = this.selectedAttrs.filter(a => this.colFilters[a]).length + (this.statusFilter ? 1 : 0);
    const filterChip    = activeFilters > 0
      ? `<button id="ak-clear-filt" style="margin-left:10px;padding:3px 9px;background:#fff3e0;color:#e65100;border:1px solid #ffe0b2;border-radius:10px;font-size:11px;font-weight:600;cursor:pointer;">${activeFilters} filtre aktif — temizle ✕</button>`
      : "";

    const colCount = (this.selectedAttrs.length === 0 ? 1 : this.selectedAttrs.length) + 2;
    const emptyRow = `<tr><td colspan="${colCount}" style="padding:30px;text-align:center;color:#adb5bd;font-size:12px;">Filtreyle eşleşen kayıt yok</td></tr>`;

    const hintHtml = (cat && cat.hint)
      ? `<div style="background:#e8f0fa;border-left:3px solid #1D5FA3;padding:8px 12px;font-size:12px;color:#1D5FA3;border-radius:0 6px 6px 0;margin-bottom:12px;">${cat.hint}</div>`
      : "";

    this.setMain(`
      ${this.ctxBar(2)}
      ${hintHtml}
      <div style="background:white;border:1px solid #e9ecef;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.08);">
        <div style="padding:10px 16px;border-bottom:1px solid #e9ecef;display:flex;align-items:center;flex-wrap:wrap;">
          <span style="font-weight:700;">${cat ? cat.unitLabel.replace(" (m)","").replace(" (TL)","") : "Değer"} Tablosu</span>
          ${filterChip}
          <span style="font-size:11px;color:#6c757d;margin-left:auto;">${visible.length} görüntüleniyor / ${filledTotal} dolu / ${total} toplam</span>
        </div>
        <div style="padding:14px;">
          <div style="margin-bottom:12px;">
            <div style="display:flex;justify-content:space-between;font-size:11px;color:#6c757d;margin-bottom:4px;"><span>Tamamlanma</span><span>${pct}%</span></div>
            <div style="height:5px;background:#e9ecef;border-radius:3px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:#2e7d32;border-radius:3px;"></div></div>
          </div>
          <div style="overflow-x:auto;">
            <table style="width:100%;border-collapse:collapse;font-size:13px;table-layout:auto;">
              <thead>
                <tr>
                  ${this.selectedAttrs.length === 0
                    ? `<th style="${TH}">Kapsam</th>`
                    : this.selectedAttrs.map(a => `<th style="${TH}">${a}</th>`).join("")}
                  <th style="${TH}color:#1D5FA3;">${cat ? cat.unitLabel : "Değer"}</th>
                  <th style="${TH}">Durum</th>
                </tr>
                <tr>
                  ${this.selectedAttrs.length === 0
                    ? `<th style="${FILT_BG}"></th>`
                    : filterCells}
                  <th style="${FILT_BG}"></th>
                  ${statusFilterCell}
                </tr>
              </thead>
              <tbody>${visible.length > 0 ? rows : emptyRow}</tbody>
            </table>
          </div>
          <div style="display:flex;align-items:center;gap:10px;margin-top:14px;flex-wrap:wrap;">
            <button id="ak-back" style="padding:7px 14px;background:#f1f3f5;color:#343a40;border:1px solid #e9ecef;border-radius:6px;font-size:13px;cursor:pointer;">← Parametreler</button>
            <button id="ak-save" style="padding:7px 18px;background:#2e7d32;color:white;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;">💾 Tümünü Kaydet</button>
            ${this.dirty ? `<span style="font-size:11px;color:#e65100;">⚠️ Kaydedilmemiş değişiklik var</span>` : ""}
          </div>
        </div>
      </div>`);
  }

  private onFilterChange(e: JQueryEventObject): void {
    const key = $(e.currentTarget).attr("data-filter") as string;
    const val = ($(e.currentTarget).val() as string) || "";
    if (key === "__status") this.statusFilter = val;
    else {
      if (val) this.colFilters[key] = val;
      else delete this.colFilters[key];
    }
    this.renderMatrix();
  }

  private clearFilters(): void {
    this.colFilters   = {};
    this.statusFilter = "";
    this.renderMatrix();
  }

  private attemptBackHome(): void {
    if (this.dirty) {
      this.showConfirm(
        "Kaydedilmemiş değişiklikler var.\nKategori seçimine dönerseniz değişiklikler kaybolacak. Devam edilsin mi?",
        () => this.goHome()
      );
      return;
    }
    this.goHome();
  }

  private goHome(): void {
    this.dirty         = false;
    this.season        = "";
    this.brand         = "";
    this.styleCategory = "";
    this.selectedAttrs = [];
    this.originalAttrs = [];
    this.matrixRows    = [];
    this.colFilters    = {};
    this.statusFilter  = "";
    this.renderCategoryPicker();
  }

  private onInput(e: JQueryEventObject): void {
    const idx = parseInt($(e.currentTarget).attr("data-row") as string, 10);
    const raw = ($(e.currentTarget).val() as string);
    const val = raw === "" ? null : parseFloat(raw);
    if (val !== null && isNaN(val)) return;
    this.matrixRows[idx].consumption = val;
    this.dirty = true;
    this.$el.find(`#ak-st-${idx}`).html(this.statusHtml(this.matrixRows[idx]));
    const bg  = val !== null ? "#e8f5e9" : "white";
    const bdr = val !== null ? "#2e7d32" : "#e9ecef";
    $(e.currentTarget).css({ background: bg, borderColor: bdr });
  }

  private statusHtml(r: MatrixRow): string {
    if (r.consumption === null)          return `<span style="font-size:11px;color:#adb5bd;">— Boş</span>`;
    if (r.consumption === r.savedValue)  return `<span style="font-size:11px;color:#2e7d32;font-weight:600;">✓ Kayıtlı</span>`;
    return `<span style="font-size:11px;color:#e65100;">● Değişti</span>`;
  }

  private backToAttrs(): void {
    const hasSaved = this.matrixRows.some(r => r.savedValue !== null);
    const msg = this.dirty
      ? "Kaydedilmemiş değişiklikler var.\nParametre seçimini değiştirirseniz sarf değerleri silinebilir. Devam etmek istiyor musunuz?"
      : hasSaved
        ? "Parametre seçimine döneceğiniz. Seçimi değiştirirseniz sarf değerleri silinir. Devam etmek istiyor musunuz?"
        : null;

    if (msg) { this.showConfirm(msg, () => this.doBackToAttrs()); return; }
    this.doBackToAttrs();
  }

  private doBackToAttrs(): void {
    this.dirty = false;
    this.renderAttrSelect();
  }

  private saveValues(): void {
    const cat = getCategory(this.currentCategory);
    const unit = cat ? cat.unit : "m";
    const values = this.matrixRows
      .filter(r => r.consumption !== null && !isNaN(r.consumption as number))
      .map(r => ({ attrCombo: r.combo, consumption: r.consumption, unit: unit }));

    this.apiPost(this.combo("values"), { values }, (_res: any) => {
      this.matrixRows.forEach(r => { r.savedValue = r.consumption; });
      this.dirty = false;
      this.renderMatrix();
      this.toast(`${values.length} değer kaydedildi ✓`, "success");
    }, (_err: any) => this.toast("Kayıt hatası", "error"));
  }

  // ── UI helpers ────────────────────────────────────────────────────────────

  private ctxBar(active: number): string {
    const chip = (t: string) => `<span style="background:#e8f0fa;color:#1D5FA3;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;">${t}</span>`;
    const dot  = (n: number) => {
      const bg = n < active ? "#2e7d32" : n === active ? "#1D5FA3" : "#e9ecef";
      const c  = n <= active ? "white" : "#6c757d";
      return `<span style="display:inline-block;width:20px;height:20px;border-radius:50%;background:${bg};color:${c};text-align:center;line-height:20px;font-size:10px;font-weight:700;margin-right:3px;">${n < active ? "✓" : n}</span>`;
    };
    return `<div style="display:flex;align-items:center;gap:6px;margin-bottom:12px;flex-wrap:wrap;">
      ${chip(this.season)}<span style="color:#adb5bd;font-size:16px;">/</span>${chip(this.brand)}<span style="color:#adb5bd;font-size:16px;">/</span>${chip(this.styleCategory)}
      <span style="margin-left:auto;">${dot(1)}${dot(2)}</span>
    </div>`;
  }

  private setMain(html: string): void { this.$el.find("#ak-main").html(html); }

  private emptyState(icon: string, msg: string): string {
    return `<div style="text-align:center;padding:40px 20px;color:#6c757d;"><div style="font-size:36px;margin-bottom:8px;">${icon}</div><p>${msg}</p></div>`;
  }

  private toast(msg: string, type: "success"|"error"|"info" = "success"): void {
    const bg = type === "success" ? "#2e7d32" : type === "error" ? "#c62828" : "#1D5FA3";
    const $t = this.$el.find("#ak-toast");
    $t.css({ background: bg, opacity: "1" }).text(msg);
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => $t.css("opacity", "0"), 3200);
  }

  // ── API helpers ───────────────────────────────────────────────────────────

  private combo(endpoint: string): string {
    const cat = getCategory(this.currentCategory);
    const base = cat ? cat.endpointBase : "/api/ana-kumash";
    return `${base}/${endpoint}/${enc(this.season)}/${enc(this.brand)}/${enc(this.styleCategory)}`;
  }

  // Heroku (ION Gateway üzerinden)
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

  // PLM doğrudan (full path, prefix yok)
  private ionGet(fullPath: string, onSuccess: (d: any) => void, onError: (e: any) => void): void {
    this.widgetContext.executeIonApiAsync({ method: "GET", url: fullPath, cache: false })
      .subscribe((res: any) => onSuccess(res.data), (err: any) => onError(err));
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function cartesian<T>(arrays: T[][]): T[][] {
  return arrays.reduce<T[][]>((acc, arr) => {
    const out: T[][] = [];
    for (const a of acc) for (const b of arr) out.push([...a, b]);
    return out;
  }, [[]]);
}

function comboKey(c: AttrCombo): string {
  return JSON.stringify(Object.fromEntries(Object.entries(c).sort(([a],[b]) => a.localeCompare(b))));
}

function sortedKey(a: string[]): string { return [...a].sort().join("|"); }
function enc(s: string): string { return encodeURIComponent(s); }
function esc(s: string): string { return s.replace(/"/g, "&quot;"); }

export const widgetFactory = (context: IWidgetContext): IWidgetInstance => new AnaKumashWidget(context);
