import { IWidgetContext, IWidgetInstance, Log } from "lime";

declare var $: JQueryStatic;

const API_BASE = "/CustomerApi/brprecostparams";
const PLM_LOOKUP   = "/FASHIONPLM/odata2/api/odata2/GenericLookUpAll/GetAllLookups";
const PLM_EXT_DEF  = "/FASHIONPLM/odata2/api/odata2/STYLEEXTENDEDFIELDS";
const PLM_EXT_DROP = "/FASHIONPLM/odata2/api/odata2/EXTENDEDFIELDDROPDOWN";

// Bunlar Widget 1 ile birebir aynı tutulmalı.
const SELECTOR_MAP: { [id: number]: string } = {
  1:  "Marka",
  51: "Kategori",
  58: "Sezon",
};

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

const REFERENCE_MAP: { [id: number]: string } = {
  197: "Kumaş Eni",
};

interface Step { key: string; label: string; status: "pending" | "running" | "done" | "error"; detail: string; }

class CacheRefreshWidget implements IWidgetInstance {
  private $el: JQuery;
  private busy = false;
  private steps: Step[] = [];
  private lastSummary: any = null;
  private cacheInfo: { lastRefreshedAt: string | null; counts: { selectors: number; costAttrs: number; references: number; totalValues: number } } | null = null;
  private toastTimer: any = null;

  constructor(private widgetContext: IWidgetContext) {
    this.$el = widgetContext.getElement();
    this.renderShell();
    this.bindAll();
    this.loadStatus();
  }

  settingsSaved(): void {}
  dispose(): void { this.$el.off(); }

  // ── UI ─────────────────────────────────────────────────────────────────────

  private renderShell(): void {
    this.$el.html(`
      <div style="font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#343a40;background:#f8f9fa;min-height:340px;position:relative;">

        <div style="background:#1D5FA3;color:white;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;">
          <span style="font-size:14px;font-weight:600;">PreCost — Lookup Cache Yönetimi</span>
          <span style="background:rgba(255,255,255,.2);padding:2px 8px;border-radius:10px;font-size:11px;">Admin</span>
        </div>

        <div style="padding:14px 16px;">
          <div id="cr-status" style="background:white;border:1px solid #e9ecef;border-radius:6px;padding:14px 16px;margin-bottom:14px;box-shadow:0 1px 4px rgba(0,0,0,.08);">
            Cache durumu yükleniyor…
          </div>

          <div style="display:flex;gap:8px;margin-bottom:14px;">
            <button id="cr-refresh" style="padding:9px 18px;background:#1D5FA3;color:white;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;">
              ↻ PLM'den Şimdi Güncelle
            </button>
            <button id="cr-reload" style="padding:9px 14px;background:white;color:#1D5FA3;border:1px solid #1D5FA3;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;">
              Durumu Yenile
            </button>
          </div>

          <div id="cr-progress" style="display:none;background:white;border:1px solid #e9ecef;border-radius:6px;padding:12px 16px;margin-bottom:14px;box-shadow:0 1px 4px rgba(0,0,0,.08);">
            <div style="font-weight:700;font-size:12px;color:#6c757d;text-transform:uppercase;letter-spacing:.4px;margin-bottom:10px;">İşlem akışı</div>
            <div id="cr-step-list"></div>
          </div>

          <div id="cr-detail"></div>

          <details style="margin-top:14px;background:white;border:1px solid #e9ecef;border-radius:6px;padding:8px 14px;">
            <summary style="cursor:pointer;font-weight:600;font-size:12px;color:#6c757d;">Bu widget ne yapar?</summary>
            <div style="font-size:12px;color:#495057;line-height:1.55;padding:8px 0;">
              <strong>↻ PLM'den Şimdi Güncelle</strong>'ye bastığında:
              <ol style="margin:6px 0 6px 18px;padding:0;">
                <li>PLM'in 3 lookup endpoint'i çağrılır <em>(GenericLookUpAll, STYLEEXTENDEDFIELDS, EXTENDEDFIELDDROPDOWN)</em>.</li>
                <li>Selector + standart cost-attr + extended cost-attr (FieldType=4) + reference (Kumaş Eni) listeleri payload'a dönüştürülür.</li>
                <li>Heroku'daki <code>POST /api/lookup/refresh</code> çağrısıyla cache TRUNCATE + reinsert edilir.</li>
                <li>Cache özeti güncel verilerle yeniden çekilir.</li>
              </ol>
              Normal akışta Widget 1 zaten 24 saatten eski cache'i arka planda otomatik yeniler. Bu widget, beklenmedik bir ihtiyaç için manuel tetikleme imkanı sağlar.
            </div>
          </details>
        </div>

        <div id="cr-toast" style="position:absolute;bottom:18px;right:18px;padding:10px 18px;border-radius:6px;font-size:13px;font-weight:600;color:white;box-shadow:0 4px 16px rgba(0,0,0,.2);opacity:0;transition:opacity .25s;z-index:1000;pointer-events:none;"></div>
      </div>
    `);
  }

  private bindAll(): void {
    this.$el.on("click", "#cr-refresh", () => this.runRefresh());
    this.$el.on("click", "#cr-reload",  () => this.loadStatus());
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  private loadStatus(): void {
    this.$el.find("#cr-status").html("Cache durumu yükleniyor…");
    this.apiGet("/api/lookup/all", (data: any) => {
      const attrs = (data && data.attributes) ? data.attributes : [];
      const counts = { selectors: 0, costAttrs: 0, references: 0, totalValues: 0 };
      for (const a of attrs) {
        if (a.role === "selector")   counts.selectors++;
        if (a.role === "cost-attr")  counts.costAttrs++;
        if (a.role === "reference")  counts.references++;
        counts.totalValues += (a.values || []).length;
      }
      this.cacheInfo = { lastRefreshedAt: data ? data.lastRefreshedAt : null, counts };
      this.renderStatus(data && data.stale, data && data.schemaStale);
      this.renderDetail(attrs);
    }, (err: any) => {
      Log.error("[CacheRefresh] /api/lookup/all error: " + JSON.stringify(err));
      this.$el.find("#cr-status").html(`<span style="color:#c62828;">Cache durumu okunamadı.</span>`);
    });
  }

  private renderStatus(stale: boolean, schemaStale: boolean): void {
    if (!this.cacheInfo) return;
    const { lastRefreshedAt, counts } = this.cacheInfo;
    const age = lastRefreshedAt ? this.formatAge(lastRefreshedAt) : "—";
    const tsLocal = lastRefreshedAt ? new Date(lastRefreshedAt).toLocaleString() : "—";

    const badge = stale
      ? `<span style="background:#fff3e0;color:#e65100;padding:3px 10px;border-radius:10px;font-size:11px;font-weight:700;">${schemaStale ? "Schema güncel değil" : "Bayat (>24s)"}</span>`
      : `<span style="background:#e8f5e9;color:#2e7d32;padding:3px 10px;border-radius:10px;font-size:11px;font-weight:700;">Güncel</span>`;

    this.$el.find("#cr-status").html(`
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px;">
        <span style="font-weight:700;">Cache Durumu</span>${badge}
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;font-size:12px;">
        <div><div style="color:#6c757d;font-size:11px;text-transform:uppercase;letter-spacing:.4px;">Son Yenileme</div><div style="margin-top:2px;font-weight:600;">${age}</div><div style="color:#6c757d;font-size:11px;">${tsLocal}</div></div>
        <div><div style="color:#6c757d;font-size:11px;text-transform:uppercase;letter-spacing:.4px;">Selector</div><div style="margin-top:2px;font-size:18px;font-weight:700;color:#1D5FA3;">${counts.selectors}</div></div>
        <div><div style="color:#6c757d;font-size:11px;text-transform:uppercase;letter-spacing:.4px;">Cost-Attr</div><div style="margin-top:2px;font-size:18px;font-weight:700;color:#1D5FA3;">${counts.costAttrs}</div></div>
        <div><div style="color:#6c757d;font-size:11px;text-transform:uppercase;letter-spacing:.4px;">Reference</div><div style="margin-top:2px;font-size:18px;font-weight:700;color:#1D5FA3;">${counts.references}</div></div>
        <div><div style="color:#6c757d;font-size:11px;text-transform:uppercase;letter-spacing:.4px;">Toplam Değer</div><div style="margin-top:2px;font-size:18px;font-weight:700;color:#1D5FA3;">${counts.totalValues}</div></div>
      </div>
    `);
  }

  private renderDetail(attrs: any[]): void {
    if (!attrs || attrs.length === 0) {
      this.$el.find("#cr-detail").html(`
        <div style="background:white;border:1px dashed #e9ecef;border-radius:6px;padding:20px;text-align:center;color:#adb5bd;">
          Cache henüz hiç doldurulmamış. <strong>"PLM'den Şimdi Güncelle"</strong> butonuna basın.
        </div>`);
      return;
    }

    const TH = "text-align:left;padding:7px 10px;background:#f1f3f5;border-bottom:2px solid #e9ecef;font-size:11px;font-weight:700;color:#6c757d;text-transform:uppercase;";
    const TD = "padding:6px 10px;border-bottom:1px solid #f1f3f5;font-size:12px;vertical-align:top;";

    const rows = attrs.map(a => {
      const roleColor = a.role === "selector" ? "#1565c0" : a.role === "cost-attr" ? "#2e7d32" : "#6a1b9a";
      const sample = (a.values || []).slice(0, 3).map((v: any) => v.name).join(", ");
      const more = (a.values || []).length > 3 ? `<span style="color:#adb5bd;"> … +${a.values.length - 3}</span>` : "";
      return `<tr>
        <td style="${TD}"><span style="color:${roleColor};font-weight:600;text-transform:uppercase;font-size:10px;letter-spacing:.4px;">${a.role}</span></td>
        <td style="${TD}">${a.source}</td>
        <td style="${TD};font-family:monospace;color:#6c757d;">${a.sourceId}</td>
        <td style="${TD};font-weight:600;">${a.label}</td>
        <td style="${TD};text-align:right;">${(a.values || []).length}</td>
        <td style="${TD};color:#6c757d;">${sample}${more}</td>
      </tr>`;
    }).join("");

    this.$el.find("#cr-detail").html(`
      <div style="background:white;border:1px solid #e9ecef;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.08);overflow:hidden;">
        <div style="padding:10px 16px;border-bottom:1px solid #e9ecef;font-weight:700;">Cache İçeriği</div>
        <div style="overflow-x:auto;">
          <table style="width:100%;border-collapse:collapse;">
            <thead><tr>
              <th style="${TH}">Rol</th>
              <th style="${TH}">Kaynak</th>
              <th style="${TH}">Source ID</th>
              <th style="${TH}">Etiket</th>
              <th style="${TH};text-align:right;">Değer Sayısı</th>
              <th style="${TH}">Örnek değerler</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `);
  }

  // ── Refresh akışı ──────────────────────────────────────────────────────────

  private runRefresh(): void {
    if (this.busy) return;
    this.busy = true;

    this.steps = [
      { key: "lookup",  label: "GenericLookUpAll çağrısı",        status: "pending", detail: "" },
      { key: "extdef",  label: "STYLEEXTENDEDFIELDS çağrısı",     status: "pending", detail: "" },
      { key: "extdrop", label: "EXTENDEDFIELDDROPDOWN çağrısı",   status: "pending", detail: "" },
      { key: "build",   label: "Payload oluşturma",                status: "pending", detail: "" },
      { key: "post",    label: "Heroku /api/lookup/refresh",       status: "pending", detail: "" },
      { key: "reload",  label: "Cache özeti yenileniyor",          status: "pending", detail: "" },
    ];
    this.$el.find("#cr-progress").css("display", "block");
    this.$el.find("#cr-refresh").prop("disabled", true).css({ opacity: ".6", cursor: "not-allowed" }).text("Yenileniyor…");
    this.renderSteps();

    this.setStep("lookup", "running");
    this.ionGet(PLM_LOOKUP, (lookupRes: any) => {
      const lookupItems = (lookupRes && lookupRes.value) || [];
      this.setStep("lookup", "done", `${lookupItems.length} satır`);

      this.setStep("extdef", "running");
      this.ionGet(PLM_EXT_DEF, (extDefRes: any) => {
        const extDefItems = (extDefRes && extDefRes.value) || [];
        this.setStep("extdef", "done", `${extDefItems.length} satır`);

        this.setStep("extdrop", "running");
        this.ionGet(PLM_EXT_DROP, (extDropRes: any) => {
          const extDropItems = (extDropRes && extDropRes.value) || [];
          this.setStep("extdrop", "done", `${extDropItems.length} satır`);

          this.setStep("build", "running");
          let payload: any;
          try {
            payload = this.buildRefreshPayload(lookupItems, extDefItems, extDropItems);
          } catch (e: any) {
            this.setStep("build", "error", e && e.message ? e.message : String(e));
            this.finish(false);
            return;
          }
          const totalItems = (payload.selectors.length + payload.costAttrs.length + payload.references.length);
          const totalVals  = [...payload.selectors, ...payload.costAttrs, ...payload.references]
            .reduce((sum: number, a: any) => sum + (a.values || []).length, 0);
          this.setStep("build", "done", `${totalItems} attr / ${totalVals} değer`);

          this.setStep("post", "running");
          this.apiPost("/api/lookup/refresh", payload, (resp: any) => {
            this.lastSummary = resp;
            this.setStep("post", "done", `count=${resp ? resp.count : "?"}`);

            this.setStep("reload", "running");
            this.loadStatus();
            this.setStep("reload", "done", "ok");
            this.finish(true);
          }, (err: any) => {
            const msg = err && err.statusText ? err.statusText : (err && err.data && err.data.error ? err.data.error : "POST hatası");
            this.setStep("post", "error", msg);
            Log.error("[CacheRefresh] /api/lookup/refresh error: " + JSON.stringify(err));
            this.finish(false);
          });
        }, (err: any) => { this.setStep("extdrop", "error", this.errMsg(err)); this.finish(false); });
      }, (err: any) => { this.setStep("extdef", "error", this.errMsg(err)); this.finish(false); });
    }, (err: any) => { this.setStep("lookup", "error", this.errMsg(err)); this.finish(false); });
  }

  private finish(ok: boolean): void {
    this.busy = false;
    this.$el.find("#cr-refresh").prop("disabled", false).css({ opacity: "1", cursor: "pointer" }).text("↻ PLM'den Şimdi Güncelle");
    this.toast(ok ? "Cache güncellendi ✓" : "Cache güncellenemedi", ok ? "success" : "error");
  }

  private setStep(key: string, status: Step["status"], detail = ""): void {
    const s = this.steps.find(x => x.key === key);
    if (!s) return;
    s.status = status;
    if (detail) s.detail = detail;
    this.renderSteps();
  }

  private renderSteps(): void {
    const html = this.steps.map(s => {
      const icon = s.status === "done"    ? `<span style="color:#2e7d32;">✓</span>`
                 : s.status === "error"   ? `<span style="color:#c62828;">✗</span>`
                 : s.status === "running" ? `<span style="color:#1D5FA3;">⏳</span>`
                                          : `<span style="color:#adb5bd;">○</span>`;
      const color = s.status === "error" ? "#c62828" : s.status === "done" ? "#343a40" : "#6c757d";
      return `<div style="display:flex;align-items:center;gap:10px;padding:5px 0;font-size:12px;color:${color};">
        <span style="width:18px;text-align:center;font-size:14px;">${icon}</span>
        <span style="flex:1;">${s.label}</span>
        <span style="color:#adb5bd;font-size:11px;">${s.detail}</span>
      </div>`;
    }).join("");
    this.$el.find("#cr-step-list").html(html);
  }

  // ── Payload üretimi (Widget 1 ile birebir aynı) ────────────────────────────

  private buildRefreshPayload(lookupItems: any[], extDefItems: any[], extDropItems: any[]): any {
    const selectors = Object.keys(SELECTOR_MAP).map(idStr => {
      const id    = parseInt(idStr, 10);
      const label = SELECTOR_MAP[id];
      const values = lookupItems
        .filter(it => it.GlrefId === id && it.Status === 1 && it.Name)
        .sort((a, b) => (a.sequence || 0) - (b.sequence || 0))
        .map(it => ({ id: String(it.GlValId), name: String(it.Name).trim(), code: it.Code || null, seq: it.sequence || 0 }));
      return { key: label, sourceId: String(id), values };
    });

    const standardCost = Object.keys(STANDARD_COST_MAP).map(idStr => {
      const id    = parseInt(idStr, 10);
      const label = STANDARD_COST_MAP[id];
      const values = lookupItems
        .filter(it => it.GlrefId === id && it.Status === 1 && it.Name)
        .sort((a, b) => (a.sequence || 0) - (b.sequence || 0))
        .map(it => ({ id: String(it.GlValId), name: String(it.Name).trim(), code: it.Code || null, seq: it.sequence || 0 }));
      return { key: label, source: "standard", sourceId: String(id), values };
    });

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
      .filter(e => e.values.length > 0);

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

  // ── Helpers ────────────────────────────────────────────────────────────────

  private errMsg(err: any): string {
    if (!err) return "bilinmeyen hata";
    if (err.statusText) return err.statusText;
    if (err.message)    return err.message;
    return JSON.stringify(err).slice(0, 120);
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

  private toast(msg: string, type: "success"|"error"|"info" = "success"): void {
    const bg = type === "success" ? "#2e7d32" : type === "error" ? "#c62828" : "#1D5FA3";
    const $t = this.$el.find("#cr-toast");
    $t.css({ background: bg, opacity: "1" }).text(msg);
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => $t.css("opacity", "0"), 3500);
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

export const widgetFactory = (context: IWidgetContext): IWidgetInstance => new CacheRefreshWidget(context);
