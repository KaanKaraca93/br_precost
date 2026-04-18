import { IWidgetContext, IWidgetInstance, Log } from "lime";

declare var $: JQueryStatic;

// ── Config ─────────────────────────────────────────────────────────────────
// ION API Gateway üzerinden kayıtlı Heroku API'nin yolu
const API_BASE = "/CustomerApi/brprecostparams";

// ── Types ───────────────────────────────────────────────────────────────────
interface AttributeMap      { [name: string]: string[] }
interface AttrCombo         { [name: string]: string }
interface MatrixRow         { combo: AttrCombo; consumption: number | null; savedValue: number | null }
interface ConsumptionValue  { attrCombo: AttrCombo; consumption: number | null; unit: string }

// ── Widget ──────────────────────────────────────────────────────────────────
class AnaKumashWidget implements IWidgetInstance {
  private $el: JQuery;

  private allAttrs:      AttributeMap = {};
  private selectedAttrs: string[]     = [];
  private originalAttrs: string[]     = [];
  private matrixRows:    MatrixRow[]  = [];

  private season        = "";
  private brand         = "";
  private styleCategory = "";
  private step          = 0;
  private dirty         = false;
  private toastTimer:   any = null;

  constructor(private widgetContext: IWidgetContext) {
    this.$el = widgetContext.getElement();
    this.renderShell();
    this.bindAll();
    this.fetchAttributes();
  }

  settingsSaved(): void {}

  dispose(): void {
    this.$el.off();
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  private fetchAttributes(): void {
    this.apiGet("/api/ana-kumash/attributes",
      (data: AttributeMap) => { this.allAttrs = data; },
      (err: any) => Log.error("[PreCost] Attributes error: " + JSON.stringify(err))
    );
  }

  // ── Event binding (tek seferlik, constructor'da) ───────────────────────────

  private bindAll(): void {
    // Selector bar
    this.$el.on("click",  "#ak-load-btn",   () => this.loadCombination());
    this.$el.on("keydown","#ak-category",   (e: JQueryKeyEventObject) => {
      if (e.key === "Enter") this.loadCombination();
    });

    // Step 1 — attribute kartları (event delegation)
    this.$el.on("click", "[data-attr-toggle]", (e: JQueryEventObject) => {
      const name = $(e.currentTarget).attr("data-attr-toggle") as string;
      this.toggleAttr(name);
    });
    this.$el.on("click", "#ak-to-matrix",  () => this.goToMatrix());

    // Step 2 — matris
    this.$el.on("input", "[data-row-idx]", (e: JQueryEventObject) => {
      const idx    = parseInt($(e.currentTarget).attr("data-row-idx") as string, 10);
      const rawVal = ($(e.currentTarget).val() as string);
      const val    = rawVal === "" ? null : parseFloat(rawVal);
      if (val !== null && isNaN(val)) return;
      this.matrixRows[idx].consumption = val;
      this.dirty = true;
      this.updateRowStatus(idx);
    });
    this.$el.on("click", "#ak-back-btn", () => this.backToAttrs());
    this.$el.on("click", "#ak-save-btn", () => this.saveValues());
  }

  // ── Shell ─────────────────────────────────────────────────────────────────

  private renderShell(): void {
    const seasons = ["SS26", "FW26", "SS27", "FW27", "SS28"];
    const brands  = ["Altınyıldız", "Beymen Business", "Beymen Club", "Network", "Kiğılı"];

    const seasonOpts = seasons.map(s => `<option value="${s}">${s}</option>`).join("");
    const brandOpts  = brands.map(b  => `<option value="${b}">${b}</option>`).join("");

    this.$el.html(`
      <div style="font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#343a40;background:#f8f9fa;min-height:400px;">

        <div style="background:#1D5FA3;color:white;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;">
          <span style="font-size:14px;font-weight:600;">Ana Kumaş Sarf — Parametre & Değer Tanımı</span>
          <span style="background:rgba(255,255,255,.2);padding:2px 8px;border-radius:10px;font-size:11px;">PreCost v1</span>
        </div>

        <div style="padding:12px 16px;">

          <div style="background:white;border:1px solid #e9ecef;border-radius:6px;padding:10px 14px;margin-bottom:14px;display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;box-shadow:0 1px 4px rgba(0,0,0,.08);">
            <div style="display:flex;flex-direction:column;gap:4px;">
              <label style="font-size:11px;font-weight:600;color:#6c757d;text-transform:uppercase;letter-spacing:.4px;">Sezon</label>
              <select id="ak-season" style="padding:6px 10px;border:1px solid #e9ecef;border-radius:6px;font-size:13px;min-width:90px;outline:none;">
                <option value="">Seçiniz</option>${seasonOpts}
              </select>
            </div>
            <div style="display:flex;flex-direction:column;gap:4px;">
              <label style="font-size:11px;font-weight:600;color:#6c757d;text-transform:uppercase;letter-spacing:.4px;">Marka</label>
              <select id="ak-brand" style="padding:6px 10px;border:1px solid #e9ecef;border-radius:6px;font-size:13px;min-width:140px;outline:none;">
                <option value="">Seçiniz</option>${brandOpts}
              </select>
            </div>
            <div style="display:flex;flex-direction:column;gap:4px;">
              <label style="font-size:11px;font-weight:600;color:#6c757d;text-transform:uppercase;letter-spacing:.4px;">Kategori</label>
              <input id="ak-category" type="text" placeholder="örn. Ceket"
                style="padding:6px 10px;border:1px solid #e9ecef;border-radius:6px;font-size:13px;min-width:120px;outline:none;" />
            </div>
            <button id="ak-load-btn"
              style="padding:7px 16px;background:#1D5FA3;color:white;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;">
              Yükle
            </button>
          </div>

          <div id="ak-main">
            ${this.emptyState("🔍", "Sezon, marka ve kategori seçip <strong>Yükle</strong>'ye basın")}
          </div>

        </div>

        <div id="ak-toast" style="position:fixed;bottom:18px;right:18px;padding:10px 18px;border-radius:6px;font-size:13px;font-weight:600;color:white;box-shadow:0 4px 16px rgba(0,0,0,.2);opacity:0;transition:opacity .25s;z-index:9999;pointer-events:none;"></div>
      </div>
    `);
  }

  // ── Load combination ──────────────────────────────────────────────────────

  private loadCombination(): void {
    this.season        = ((this.$el.find("#ak-season").val()   as string) || "").trim();
    this.brand         = ((this.$el.find("#ak-brand").val()    as string) || "").trim();
    this.styleCategory = ((this.$el.find("#ak-category").val() as string) || "").trim();

    if (!this.season || !this.brand || !this.styleCategory) {
      this.toast("Sezon, marka ve kategori zorunlu", "error"); return;
    }

    this.setMain(this.emptyState("⏳", "Yükleniyor…"));

    const cfgPath = `/api/ana-kumash/config/${enc(this.season)}/${enc(this.brand)}/${enc(this.styleCategory)}`;
    const valPath = `/api/ana-kumash/values/${enc(this.season)}/${enc(this.brand)}/${enc(this.styleCategory)}`;

    this.apiGet(cfgPath, (cfg: { selectedAttrs: string[] }) => {
      this.selectedAttrs = cfg.selectedAttrs || [];
      this.originalAttrs = [...this.selectedAttrs];

      this.apiGet(valPath, (vals: ConsumptionValue[]) => {
        if (this.selectedAttrs.length > 0) {
          this.buildMatrixRows(vals);
          this.step = 2;
          this.renderMatrix();
        } else {
          this.step = 1;
          this.renderAttrSelect();
        }
      }, (err: any) => Log.error("[PreCost] Values error: " + JSON.stringify(err)));

    }, (err: any) => {
      this.setMain(this.emptyState("⚠️", "API hatası: " + JSON.stringify(err)));
    });
  }

  // ── Step 1: Attribute Selection ───────────────────────────────────────────

  private renderAttrSelect(): void {
    const cards = Object.entries(this.allAttrs).map(([name, values]) => {
      const isSel  = this.selectedAttrs.includes(name);
      const border = isSel ? "#1D5FA3" : "#e9ecef";
      const bg     = isSel ? "#e8f0fa" : "white";
      const chips  = values.map(v =>
        `<span style="background:${isSel?"white":"#f1f3f5"};color:${isSel?"#1D5FA3":"#6c757d"};padding:2px 7px;border-radius:10px;font-size:11px;margin:2px 2px 0 0;display:inline-block;">${v}</span>`
      ).join("");

      return `
        <div data-attr-toggle="${esc(name)}"
          style="border:2px solid ${border};background:${bg};border-radius:6px;padding:10px 12px;cursor:pointer;user-select:none;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <div style="width:16px;height:16px;border-radius:4px;border:2px solid ${isSel?"#1D5FA3":"#adb5bd"};background:${isSel?"#1D5FA3":"transparent"};display:flex;align-items:center;justify-content:center;color:white;font-size:10px;flex-shrink:0;">${isSel?"✓":""}</div>
            <span style="font-weight:700;">${name}</span>
            <span style="font-size:11px;color:#6c757d;margin-left:auto;">${values.length} değer</span>
          </div>
          <div>${chips}</div>
        </div>
      `;
    }).join("");

    const selCount = this.selectedAttrs.length;
    const comboCount = selCount > 0
      ? this.selectedAttrs.reduce((acc, a) => acc * (this.allAttrs[a]?.length || 1), 1)
      : 0;
    const preview = selCount > 0
      ? `<div style="margin-top:10px;padding:8px 12px;background:#e8f5e9;border-radius:6px;font-size:12px;color:#2e7d32;">
           ✓ Matris boyutu: ${this.selectedAttrs.map(a => this.allAttrs[a].length).join(" × ")} = <strong>${comboCount} kombinasyon</strong>
         </div>`
      : "";

    this.setMain(`
      ${this.ctxBar(1)}
      <div style="background:white;border:1px solid #e9ecef;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.08);">
        <div style="padding:10px 16px;border-bottom:1px solid #e9ecef;display:flex;align-items:center;gap:8px;">
          <span style="font-size:13px;font-weight:700;">Etken Parametreleri Seçin</span>
          <span style="font-size:11px;color:#6c757d;margin-left:auto;">Hangi ürün özellikleri kumaş sarfını etkiliyor?</span>
        </div>
        <div style="padding:14px;">
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;">
            ${cards}
          </div>
          ${preview}
          <div style="margin-top:14px;">
            <button id="ak-to-matrix"
              style="padding:7px 16px;background:#1D5FA3;color:white;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;">
              Devam →
            </button>
          </div>
        </div>
      </div>
    `);
  }

  private toggleAttr(name: string): void {
    const idx = this.selectedAttrs.indexOf(name);
    if (idx === -1) this.selectedAttrs.push(name);
    else this.selectedAttrs.splice(idx, 1);
    this.renderAttrSelect();
  }

  // ── Go to matrix ──────────────────────────────────────────────────────────

  private goToMatrix(): void {
    if (this.selectedAttrs.length === 0) {
      this.toast("En az bir parametre seçin", "error"); return;
    }

    const changed = sortedKey(this.selectedAttrs) !== sortedKey(this.originalAttrs);
    if (changed && this.originalAttrs.length > 0) {
      if (!confirm(
        "Parametre seçimi değiştirildi.\n" +
        "Bu kombinasyona ait tüm kayıtlı sarf değerleri silinecek.\n\n" +
        "Devam etmek istiyor musunuz?"
      )) return;
    }

    const cfgPath = `/api/ana-kumash/config/${enc(this.season)}/${enc(this.brand)}/${enc(this.styleCategory)}`;
    const valPath = `/api/ana-kumash/values/${enc(this.season)}/${enc(this.brand)}/${enc(this.styleCategory)}`;

    this.apiPost(cfgPath, { selectedAttrs: this.selectedAttrs }, (res: { valuesReset?: boolean }) => {
      this.originalAttrs = [...this.selectedAttrs];
      this.apiGet(valPath, (vals: ConsumptionValue[]) => {
        this.buildMatrixRows(vals);
        this.step  = 2;
        this.dirty = false;
        this.renderMatrix();
        if (res.valuesReset) this.toast("Parametre listesi değişti — eski sarf değerleri temizlendi", "info");
      }, (err: any) => Log.error("[PreCost] Values error: " + JSON.stringify(err)));

    }, (err: any) => this.toast("Config kaydetme hatası", "error"));
  }

  // ── Step 2: Value Matrix ──────────────────────────────────────────────────

  private buildMatrixRows(savedValues: ConsumptionValue[]): void {
    const arrays = this.selectedAttrs.map(a =>
      (this.allAttrs[a] || []).map(v => ({ attr: a, val: v }))
    );
    const combos = cartesian(arrays);

    const valueMap: { [key: string]: number | null } = {};
    for (const sv of savedValues) {
      valueMap[comboKey(sv.attrCombo)] = sv.consumption;
    }

    this.matrixRows = combos.map(combo => {
      const obj: AttrCombo = {};
      combo.forEach(({ attr, val }) => { obj[attr] = val; });
      const savedVal = valueMap[comboKey(obj)] ?? null;
      return { combo: obj, consumption: savedVal, savedValue: savedVal };
    });
  }

  private renderMatrix(): void {
    const filled = this.matrixRows.filter(r => r.consumption !== null).length;
    const total  = this.matrixRows.length;
    const pct    = total > 0 ? Math.round(filled / total * 100) : 0;

    const thStyle = "text-align:left;padding:7px 10px;background:#f1f3f5;border-bottom:2px solid #e9ecef;font-size:11px;font-weight:700;color:#6c757d;text-transform:uppercase;white-space:nowrap;";
    const attrHeaders = this.selectedAttrs.map(a => `<th style="${thStyle}">${a}</th>`).join("");

    const rows = this.matrixRows.map((r, i) => {
      const chips = this.selectedAttrs.map(a =>
        `<span style="display:inline-block;background:#e8f0fa;color:#1D5FA3;padding:2px 7px;border-radius:10px;font-size:11px;margin-right:3px;">${r.combo[a]}</span>`
      ).join("");

      const v    = r.consumption;
      const bg   = v !== null ? "#e8f5e9" : "white";
      const bdr  = v !== null ? "#2e7d32" : "#e9ecef";
      const statusHtml = this.statusHtml(r);

      return `
        <tr>
          <td style="padding:5px 10px;border-bottom:1px solid #f1f3f5;">${chips}</td>
          <td style="padding:5px 10px;border-bottom:1px solid #f1f3f5;">
            <input type="number" step="0.001" min="0" max="99.999"
              data-row-idx="${i}"
              value="${v !== null ? v : ""}"
              placeholder="0.000"
              style="width:100px;padding:5px 8px;border:1px solid ${bdr};border-radius:4px;font-size:13px;text-align:right;outline:none;background:${bg};" />
            <span style="font-size:11px;color:#6c757d;margin-left:3px;">m</span>
          </td>
          <td id="ak-st-${i}" style="padding:5px 10px;border-bottom:1px solid #f1f3f5;">${statusHtml}</td>
        </tr>
      `;
    }).join("");

    this.setMain(`
      ${this.ctxBar(2)}
      <div style="background:#e8f0fa;border-left:3px solid #1D5FA3;padding:8px 12px;font-size:12px;color:#1D5FA3;border-radius:0 6px 6px 0;margin-bottom:12px;">
        ℹ️ Değerler <strong>150 cm kumaş eni</strong> baz alınarak girilmelidir
      </div>
      <div style="background:white;border:1px solid #e9ecef;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.08);">
        <div style="padding:10px 16px;border-bottom:1px solid #e9ecef;display:flex;align-items:center;">
          <span style="font-size:13px;font-weight:700;">Sarf Değerleri</span>
          <span style="font-size:11px;color:#6c757d;margin-left:auto;">${filled} / ${total} kombinasyon dolu</span>
        </div>
        <div style="padding:14px;">
          <div style="margin-bottom:12px;">
            <div style="display:flex;justify-content:space-between;font-size:11px;color:#6c757d;margin-bottom:4px;">
              <span>Tamamlanma</span><span>${pct}%</span>
            </div>
            <div style="height:5px;background:#e9ecef;border-radius:3px;overflow:hidden;">
              <div style="height:100%;width:${pct}%;background:#2e7d32;border-radius:3px;"></div>
            </div>
          </div>
          <div style="overflow-x:auto;">
            <table style="width:100%;border-collapse:collapse;font-size:13px;">
              <thead>
                <tr>
                  ${attrHeaders}
                  <th style="${thStyle}color:#1D5FA3;">Sarf (m)</th>
                  <th style="${thStyle}">Durum</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
          <div style="display:flex;align-items:center;gap:10px;margin-top:14px;flex-wrap:wrap;">
            <button id="ak-back-btn"
              style="padding:7px 14px;background:#f1f3f5;color:#343a40;border:1px solid #e9ecef;border-radius:6px;font-size:13px;cursor:pointer;">
              ← Parametreler
            </button>
            <button id="ak-save-btn"
              style="padding:7px 18px;background:#2e7d32;color:white;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;">
              💾 Tümünü Kaydet
            </button>
            ${this.dirty ? `<span style="font-size:11px;color:#e65100;">⚠️ Kaydedilmemiş değişiklik var</span>` : ""}
          </div>
        </div>
      </div>
    `);
  }

  private statusHtml(r: MatrixRow): string {
    if (r.consumption === null)       return `<span style="font-size:11px;color:#adb5bd;">— Boş</span>`;
    if (r.consumption === r.savedValue) return `<span style="font-size:11px;color:#2e7d32;font-weight:600;">✓ Kayıtlı</span>`;
    return `<span style="font-size:11px;color:#e65100;">● Değişti</span>`;
  }

  private updateRowStatus(idx: number): void {
    this.$el.find(`#ak-st-${idx}`).html(this.statusHtml(this.matrixRows[idx]));
  }

  private backToAttrs(): void {
    const hasSaved = this.matrixRows.some(r => r.savedValue !== null);
    const msg = this.dirty
      ? "Kaydedilmemiş değişiklikler var.\nParametre seçimini değiştirirseniz sarf değerleri silinebilir. Devam?"
      : hasSaved
        ? "Parametre seçimine döneceğiniz. Seçimi değiştirirseniz sarf değerleri silinir. Devam?"
        : null;
    if (msg && !confirm(msg)) return;
    this.step = 1;
    this.dirty = false;
    this.renderAttrSelect();
  }

  private saveValues(): void {
    const values = this.matrixRows
      .filter(r => r.consumption !== null && !isNaN(r.consumption as number))
      .map(r => ({ attrCombo: r.combo, consumption: r.consumption, unit: "m" }));

    const path = `/api/ana-kumash/values/${enc(this.season)}/${enc(this.brand)}/${enc(this.styleCategory)}`;
    this.apiPost(path, { values }, (res: { saved: number }) => {
      this.matrixRows.forEach(r => { r.savedValue = r.consumption; });
      this.dirty = false;
      this.renderMatrix();
      this.toast(`${values.length} değer kaydedildi ✓`, "success");
    }, (_err: any) => this.toast("Kayıt hatası", "error"));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private ctxBar(active: number): string {
    const chip = (t: string) =>
      `<span style="background:#e8f0fa;color:#1D5FA3;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;">${t}</span>`;
    const dot = (n: number) => {
      const bg  = n < active ? "#2e7d32" : n === active ? "#1D5FA3" : "#e9ecef";
      const col = n <= active ? "white" : "#6c757d";
      return `<span style="display:inline-block;width:20px;height:20px;border-radius:50%;background:${bg};color:${col};text-align:center;line-height:20px;font-size:10px;font-weight:700;margin-right:3px;">${n < active ? "✓" : n}</span>`;
    };
    return `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:12px;flex-wrap:wrap;">
        ${chip(this.season)}
        <span style="color:#adb5bd;font-size:16px;">/</span>
        ${chip(this.brand)}
        <span style="color:#adb5bd;font-size:16px;">/</span>
        ${chip(this.styleCategory)}
        <span style="margin-left:auto;font-size:11px;color:#6c757d;">${dot(1)}${dot(2)}</span>
      </div>
    `;
  }

  private setMain(html: string): void {
    this.$el.find("#ak-main").html(html);
  }

  private emptyState(icon: string, msg: string): string {
    return `<div style="text-align:center;padding:40px 20px;color:#6c757d;">
      <div style="font-size:36px;margin-bottom:8px;">${icon}</div>
      <p style="font-size:13px;">${msg}</p>
    </div>`;
  }

  private toast(msg: string, type: "success" | "error" | "info" = "success"): void {
    const bg = { success: "#2e7d32", error: "#c62828", info: "#1D5FA3" }[type];
    const $t = this.$el.find("#ak-toast");
    $t.css({ background: bg, opacity: "1" }).text(msg);
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => $t.css("opacity", "0"), 3200);
  }

  // ── ION API helpers ───────────────────────────────────────────────────────

  private apiGet(
    path: string,
    onSuccess: (data: any) => void,
    onError:   (err:  any) => void
  ): void {
    this.widgetContext.executeIonApiAsync({
      method: "GET",
      url:   `${API_BASE}${path}`,
      cache: false,
    }).subscribe(
      (res: any) => onSuccess(res.data),
      (err: any) => onError(err)
    );
  }

  private apiPost(
    path: string,
    body: any,
    onSuccess: (data: any) => void,
    onError:   (err:  any) => void
  ): void {
    this.widgetContext.executeIonApiAsync({
      method:  "POST",
      url:     `${API_BASE}${path}`,
      data:    JSON.stringify(body),
      cache:   false,
      headers: { "Content-Type": "application/json" },
    }).subscribe(
      (res: any) => onSuccess(res.data),
      (err: any) => onError(err)
    );
  }
}

// ── Pure utility functions ─────────────────────────────────────────────────

function cartesian<T>(arrays: T[][]): T[][] {
  if (arrays.length === 0) return [[]];
  return arrays.reduce<T[][]>((acc, arr) => {
    const out: T[][] = [];
    for (const a of acc) for (const b of arr) out.push([...a, b]);
    return out;
  }, [[]]);
}

function comboKey(combo: AttrCombo): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(combo).sort(([a], [b]) => a.localeCompare(b)))
  );
}

function sortedKey(arr: string[]): string {
  return [...arr].sort().join("|");
}

function enc(s: string): string { return encodeURIComponent(s); }
function esc(s: string): string { return s.replace(/"/g, "&quot;"); }

// ── Export ─────────────────────────────────────────────────────────────────

export const widgetFactory = (context: IWidgetContext): IWidgetInstance =>
  new AnaKumashWidget(context);
