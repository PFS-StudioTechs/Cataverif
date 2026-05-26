import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BUCKET = "artisan-documents";
const CHUNK_SIZE = 20;
const MAX_PDF_PAGES = 90;

type Produit = {
  reference: string | null;
  designation: string;
  unite: string;
  prix_achat: number;
  page?: number | null;
};

type EcartPrix = {
  reference: string | null;
  designation: string;
  unite_pdf: string;
  unite_db: string;
  prix_pdf: number;
  prix_db: number;
  delta: number;
  page?: number | null;
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });

  const supabaseUrl  = Deno.env.get("SUPABASE_URL")!;
  const serviceKey   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey      = Deno.env.get("SUPABASE_ANON_KEY")!;
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY")!;

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: uErr } = await userClient.auth.getUser();
    if (uErr || !user) {
      return new Response(JSON.stringify({ error: "Non autorisé" }), { status: 401, headers: cors });
    }

    const db = createClient(supabaseUrl, serviceKey);
    const { import_id } = await req.json();
    if (!import_id) {
      return new Response(JSON.stringify({ error: "import_id requis" }), { status: 400, headers: cors });
    }

    const { data: imp, error: impErr } = await db
      .from("catalogue_imports")
      .select("statut, artisan_id, fournisseur_id, fichier_url, fichier_type")
      .eq("id", import_id)
      .single();

    if (impErr || !imp) {
      return new Response(JSON.stringify({ error: "Import introuvable" }), { status: 404, headers: cors });
    }

    let produitsSource: Produit[];
    let extractionMethod: string;

    // Priorité 1 : CSV manuel retravaillé uploadé par l'utilisateur
    const { data: csvManuel } = await db.storage.from(BUCKET).download(`extraction/${import_id}.csv`);

    // Priorité 2 : 2 CSV auto-générés (texte + tableaux)
    const [{ data: csvTextData }, { data: csvTablesData }] = await Promise.all([
      db.storage.from(BUCKET).download(`extraction/${import_id}_text.csv`),
      db.storage.from(BUCKET).download(`extraction/${import_id}_tables.csv`),
    ]);

    if (csvManuel) {
      const csvText = await csvManuel.text();
      const parsed = await parseCSV(csvText, anthropicKey);
      produitsSource = parsed.produits;
      extractionMethod = parsed.method + "_manuel";
    } else if (csvTextData || csvTablesData) {
      const textContent   = csvTextData   ? await csvTextData.text()   : "";
      const tablesContent = csvTablesData ? await csvTablesData.text() : "";
      const result = await extractFromDualCSV(textContent, tablesContent, anthropicKey);
      produitsSource = result.produits;
      extractionMethod = result.method;
    } else {
      // Fallback : analyse directe du fichier source (PDF ou image)
      const { data: fileData, error: dlErr } = await db.storage.from(BUCKET).download(imp.fichier_url);
      if (dlErr || !fileData) throw new Error(`Téléchargement fichier source: ${dlErr?.message}`);
      const buffer = await fileData.arrayBuffer();

      if (imp.fichier_type === "csv") {
        produitsSource = parseCSVDirect(await new Blob([buffer]).text());
        extractionMethod = "csv_direct";
      } else if (imp.fichier_type === "pdf") {
        produitsSource = await extractWithClaudePDF(buffer, anthropicKey);
        extractionMethod = "pdf_sonnet";
      } else {
        produitsSource = await callClaudeVision(buffer, anthropicKey);
        extractionMethod = "image_sonnet";
      }
    }

    if (imp.statut === "termine") {
      const { data: produitsDB } = await db
        .from("produits")
        .select("id, reference, designation, unite, prix_achat")
        .eq("import_id", import_id)
        .eq("actif", true);

      const dbList = (produitsDB ?? []) as Produit[];
      const result = compare(produitsSource, dbList);

      return new Response(
        JSON.stringify({
          mode: "comparaison",
          total_pdf: result.total_pdf,
          total_db: dbList.length,
          extraction_method: extractionMethod,
          manquants: result.manquants,
          fantomes: result.fantomes,
          ecarts_prix: result.ecarts_prix,
        }),
        { headers: { ...cors, "Content-Type": "application/json" } }
      );
    } else {
      return new Response(
        JSON.stringify({
          mode: "import",
          extraction_method: extractionMethod,
          total_source: produitsSource.length,
          articles: produitsSource,
        }),
        { headers: { ...cors, "Content-Type": "application/json" } }
      );
    }
  } catch (e) {
    console.error("compare-catalogue-csv error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Erreur inconnue" }),
      { status: 500, headers: cors }
    );
  }
});

// --- Extraction hybride : 2 CSV combinés ---

async function extractFromDualCSV(textContent: string, tablesContent: string, anthropicKey: string): Promise<{ produits: Produit[]; method: string }> {
  // Si tableaux structurés (avec colonnes ref/designation/prix), parser directement
  if (tablesContent) {
    const firstLine = tablesContent.replace(/\r\n/g, "\n").split("\n")[0] ?? "";
    const headers = firstLine.split(";").map(h => h.trim().toLowerCase().replace(/^﻿/, ""));
    if (isStructuredCSV(headers)) {
      return { produits: parseStructuredCSV(tablesContent, headers), method: "tables_structure" };
    }
  }

  // Sinon : envoyer les 2 sources à Claude
  const textLines = textContent ? textContent.replace(/\r\n/g, "\n").split("\n").slice(1).filter(l => l.trim()) : [];
  const tableLines = tablesContent ? tablesContent.replace(/\r\n/g, "\n").split("\n").slice(1).filter(l => l.trim()) : [];

  // Grouper par pages de 20
  const pageMap = new Map<number, { textBlocks: string[]; tableRows: string[] }>();

  for (const line of textLines) {
    const cells = line.split(";");
    const page = parseInt(cells[0] ?? "0") || 0;
    const texte = (cells[1] ?? "").trim();
    if (texte) {
      if (!pageMap.has(page)) pageMap.set(page, { textBlocks: [], tableRows: [] });
      pageMap.get(page)!.textBlocks.push(texte);
    }
  }

  for (const line of tableLines) {
    const cells = line.split(";");
    const page = parseInt(cells[0] ?? "0") || 0;
    const cellules = (cells[3] ?? "").trim();
    if (cellules) {
      if (!pageMap.has(page)) pageMap.set(page, { textBlocks: [], tableRows: [] });
      pageMap.get(page)!.tableRows.push(cellules);
    }
  }

  const pages = [...pageMap.entries()].sort(([a], [b]) => a - b);
  const all: Produit[] = [];

  for (let i = 0; i < pages.length; i += CHUNK_SIZE) {
    const chunk = pages.slice(i, i + CHUNK_SIZE);
    const chunkText = chunk.map(([page, data]) => {
      const parts = [`=== PAGE ${page} ===`];
      if (data.tableRows.length > 0) {
        parts.push("-- LIGNES DE TABLEAU --");
        parts.push(data.tableRows.join("\n"));
      }
      if (data.textBlocks.length > 0) {
        parts.push("-- BLOCS TEXTE --");
        parts.push(data.textBlocks.join("\n"));
      }
      return parts.join("\n");
    }).join("\n\n---\n\n");

    all.push(...await callClaudeHybrid(chunkText, anthropicKey));
  }

  return { produits: deduplicateSmart(all), method: "hybrid_dual_csv" };
}

async function callClaudeHybrid(text: string, anthropicKey: string): Promise<Produit[]> {
  const prompt = `Tu analyses un extrait de catalogue fournisseur. Tu disposes de DEUX sources extraites par Python :
- "LIGNES DE TABLEAU" : cellules de tableau séparées par |, dans l'ordre des colonnes du PDF
- "BLOCS TEXTE" : blocs de texte brut de la même page (descriptions, noms de gamme, headers)

Utilise les LIGNES DE TABLEAU comme source principale pour les données produits (référence, prix).
Utilise les BLOCS TEXTE pour compléter la désignation ou identifier le nom de gamme si absent du tableau.

Extrais TOUS les produits ayant un prix. Pour chaque produit :
- r : référence article (cherche un code alphanumérique court dans les cellules, null si absent)
- d : désignation complète (combine nom de gamme + description du tableau)
- u : unité de vente ("u" par défaut)
- pa : prix HT en euros (nombre décimal)
- pg : numéro de page (section === PAGE N ===)

Réponds UNIQUEMENT en JSON compact sur une seule ligne :
{"p":[{"r":"ref_ou_null","d":"designation","u":"unite","pa":0.00,"pg":1}]}

Règles :
- Si une ligne tableau contient plusieurs prix dans des colonnes distinctes = plusieurs produits (variantes)
- Ignorer les lignes sans prix ou avec prix = 0
- Ignorer les lignes qui sont des en-têtes de colonnes (pas de valeur numérique comme prix)
- r=null si absent, u="u" si absente

DONNÉES DU CATALOGUE :
${text}`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 8192, messages: [{ role: "user", content: prompt }] }),
  });

  if (!resp.ok) throw new Error(`Claude API: ${await resp.text()}`);
  const data = await resp.json();
  return parseAI((data.content?.[0]?.text ?? "").trim());
}

// --- CSV extrait (texte brut ou structuré) ---

async function parseCSV(csvText: string, anthropicKey: string): Promise<{ produits: Produit[]; method: string }> {
  const normalized = csvText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const firstLine = normalized.split("\n")[0] ?? "";
  const headers = firstLine.split(";").map(h => h.trim().toLowerCase().replace(/^﻿/, ""));

  if (isStructuredCSV(headers)) {
    return { produits: parseStructuredCSV(normalized, headers), method: "csv_structure" };
  }
  const produits = await extractFromTextCSV(normalized, anthropicKey);
  return { produits, method: "csv_texte_claude" };
}

function isStructuredCSV(headers: string[]): boolean {
  const required = ["designation", "prix_achat"];
  return required.every(r => headers.some(h => h.includes(r)));
}

function parseStructuredCSV(csvText: string, headers: string[]): Produit[] {
  const lines = csvText.split("\n").slice(1);

  const col = (...names: string[]): number => {
    for (const n of names) {
      const idx = headers.findIndex(h => h.includes(n));
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const refCol = col("ref", "reference", "code", "article");
  const desCol = col("designation", "désignation", "libellé", "nom");
  const uCol   = col("unite", "unité");
  const pCol   = col("prix_achat", "prix", "pa", "tarif");

  if (desCol === -1) return [];

  return lines.flatMap(line => {
    const cells = line.split(";").map(c => c.trim());
    const des = cells[desCol] ?? "";
    if (!des) return [];
    const pa = pCol !== -1 ? parseFloat((cells[pCol] ?? "0").replace(",", ".")) || 0 : 0;
    return [{
      reference: refCol !== -1 ? (cells[refCol] || null) : null,
      designation: des,
      unite: uCol !== -1 ? (cells[uCol] || "u") : "u",
      prix_achat: Math.max(0, pa),
      page: null,
    }];
  });
}

async function extractFromTextCSV(csvText: string, anthropicKey: string): Promise<Produit[]> {
  const lines = csvText.split("\n").slice(1);
  const pages = new Map<number, string[]>();

  for (const line of lines) {
    const cells = line.split(";");
    const page = parseInt(cells[0] ?? "0") || 0;
    const texte = (cells[1] ?? "").trim();
    if (texte) {
      if (!pages.has(page)) pages.set(page, []);
      pages.get(page)!.push(texte);
    }
  }

  const pagesText = [...pages.entries()]
    .sort(([a], [b]) => a - b)
    .map(([page, blocs]) => ({ page, text: blocs.join("\n\n") }))
    .filter(p => p.text);

  const all: Produit[] = [];
  for (let i = 0; i < pagesText.length; i += CHUNK_SIZE) {
    const chunk = pagesText.slice(i, i + CHUNK_SIZE);
    const chunkText = chunk.map(({ page, text }) => `=== PAGE ${page} ===\n${text}`).join("\n\n---\n\n");
    all.push(...await callClaudeText(chunkText, anthropicKey));
  }

  return deduplicateSmart(all);
}

async function callClaudeText(text: string, anthropicKey: string): Promise<Produit[]> {
  const prompt = `Extrais TOUS les produits de ce texte de catalogue fournisseur sans en omettre aucun.
Pour chaque produit : référence article, désignation complète, unité de vente, prix HT en euros, numéro de page.
Réponds UNIQUEMENT en JSON compact sur une seule ligne, sans aucun texte avant ou après :
{"p":[{"r":"ref_ou_null","d":"designation","u":"unite","pa":0.00,"pg":1}]}
Règles :
- r=null si absent, u="u" si absente, pa=0 si absent, pg=numéro de la section === PAGE N === où le produit apparaît.
- VARIANTES PAR CLASSE : si un article a plusieurs prix selon une classe (VENERE/AMBRA/TERRA/LUCE/FREE/CLASSIC/ANTIQUE/WIDE), extraire UN article par prix. Concaténer code + variante dans r.
- TABLEAUX MULTI-COLONNES : une ligne avec N prix = N articles distincts.
- MÊME RÉFÉRENCE SUR PAGES DIFFÉRENTES avec prix différents = produits distincts.
- DÉCLINAISONS DE TAILLE/DIMENSION : extraire UN article par dimension.
- Extraire TOUTES les lignes ayant un prix, y compris forfaits, suppléments, accessoires.
- LANGUE : ignorer les blocs purement en espagnol ou italien.

TEXTE DU CATALOGUE :
${text}`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 8192, messages: [{ role: "user", content: prompt }] }),
  });

  if (!resp.ok) throw new Error(`Claude API: ${await resp.text()}`);
  const data = await resp.json();
  return parseAI((data.content?.[0]?.text ?? "").trim());
}

// --- Fallback PDF direct ---

async function extractWithClaudePDF(buffer: ArrayBuffer, anthropicKey: string): Promise<Produit[]> {
  const pdfDoc = await PDFDocument.load(buffer);
  const totalPages = pdfDoc.getPageCount();

  if (totalPages <= MAX_PDF_PAGES) {
    return callClaudeVision(buffer, anthropicKey);
  }

  const all: Produit[] = [];
  for (let start = 0; start < totalPages; start += MAX_PDF_PAGES) {
    const end = Math.min(start + MAX_PDF_PAGES, totalPages);
    const chunk = await PDFDocument.create();
    const pages = await chunk.copyPages(pdfDoc, Array.from({ length: end - start }, (_, i) => start + i));
    pages.forEach(p => chunk.addPage(p));
    const chunkBytes = await chunk.save();
    all.push(...await callClaudeVision(chunkBytes.buffer, anthropicKey));
    if (end < totalPages) await new Promise(r => setTimeout(r, 3000));
  }
  return deduplicate(all);
}

async function callClaudeVision(buffer: ArrayBuffer, anthropicKey: string): Promise<Produit[]> {
  const bytes = new Uint8Array(buffer);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  const base64 = btoa(bin);

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "anthropic-beta": "pdfs-2024-09-25",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 32000,
      messages: [{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
          { type: "text", text: `Extrais TOUS les produits de ce catalogue fournisseur sans en omettre aucun.
Pour chaque produit : référence article, désignation complète, unité de vente, prix HT en euros.
Réponds UNIQUEMENT en JSON compact sur une seule ligne :
{"p":[{"r":"ref_ou_null","d":"designation","u":"unite","pa":0.00}]}
Règles : r=null si absent, u="u" si absente, pa=0 si absent.` },
        ],
      }],
    }),
  });

  if (!resp.ok) throw new Error(`Claude API: ${await resp.text()}`);
  const data = await resp.json();
  return parseAI((data.content?.[0]?.text ?? "").trim());
}

// --- CSV direct (fichier source CSV) ---

function parseCSVDirect(text: string): Produit[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter(l => l.trim());
  if (lines.length < 2) return [];
  const sep = lines[0].includes(";") ? ";" : ",";
  const headers = lines[0].split(sep).map(h => h.trim().toLowerCase().replace(/"/g, ""));
  const col = (...names: string[]) => names.map(n => headers.findIndex(h => h.includes(n))).find(i => i !== -1) ?? -1;
  const refCol = col("ref", "code", "article");
  const desCol = col("désignation", "designation", "libellé", "nom");
  const uCol   = col("unité", "unite");
  const pCol   = col("prix", "pa", "tarif");
  if (desCol === -1) return [];
  return lines.slice(1).flatMap(l => {
    const c = l.split(sep).map(x => x.trim().replace(/"/g, ""));
    if (!c[desCol]) return [];
    return [{
      reference: refCol !== -1 ? (c[refCol] || null) : null,
      designation: c[desCol],
      unite: uCol !== -1 ? (c[uCol] || "u") : "u",
      prix_achat: pCol !== -1 ? parseFloat((c[pCol] ?? "0").replace(",", ".")) || 0 : 0,
      page: null,
    }];
  });
}

// --- Utilitaires ---

function parseAI(text: string): Produit[] {
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed.p) && parsed.p.length > 0) {
        return parsed.p.map(normalizeProduit).filter((p: Produit) => p.designation);
      }
    } catch { /* fall through */ }
  }
  const result: Produit[] = [];
  for (const m of text.matchAll(/\{[^{}]+\}/g)) {
    try {
      const p = normalizeProduit(JSON.parse(m[0]));
      if (p.designation) result.push(p);
    } catch { /* skip */ }
  }
  return result;
}

function normalizeProduit(obj: unknown): Produit {
  const o = obj as Record<string, unknown>;
  const raw = o.pa ?? o.prix_achat ?? 0;
  const ref = o.r ?? o.reference ?? null;
  let page: number | null = null;
  try { const n = parseInt(String(o.pg ?? o.page ?? 0)); page = n > 0 ? n : null; } catch { /* ignore */ }
  return {
    reference: ref ? String(ref).trim() || null : null,
    designation: String(o.d ?? o.designation ?? "").trim(),
    unite: String(o.u ?? o.unite ?? "u").trim() || "u",
    prix_achat: Math.max(0, typeof raw === "number" ? raw : parseFloat(String(raw)) || 0),
    page,
  };
}

function deduplicateSmart(produits: Produit[]): Produit[] {
  const seen = new Set<string>();
  return produits.filter(p => {
    const key = `${(p.reference ?? "").toLowerCase()}|${p.designation.toLowerCase()}|${p.unite.toLowerCase()}|${Math.round((p.prix_achat ?? 0) * 100)}|${p.page ?? 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function deduplicate(produits: Produit[]): Produit[] {
  const seen = new Set<string>();
  return produits.filter(p => {
    const key = `${p.reference ?? ""}|${p.designation.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildIndex(produits: Produit[]): Map<string, Produit> {
  const map = new Map<string, Produit>();
  for (const p of produits) {
    const ref = (p.reference ?? "").trim().toLowerCase();
    const des = p.designation.trim().toLowerCase().slice(0, 40);
    const key = ref || des;
    if (key) map.set(key, p);
  }
  return map;
}

function compare(source: Produit[], db: Produit[]): { total_pdf: number; manquants: Produit[]; fantomes: Produit[]; ecarts_prix: EcartPrix[] } {
  const deduped = deduplicate(source);
  const indexPDF = buildIndex(deduped);
  const indexDB  = buildIndex(db);

  const manquants: Produit[]     = [];
  const fantomes: Produit[]      = [];
  const ecarts_prix: EcartPrix[] = [];

  for (const [key, p] of indexPDF) {
    if (!indexDB.has(key)) {
      manquants.push(p);
    } else {
      const d = indexDB.get(key)!;
      const delta = Math.abs((p.prix_achat ?? 0) - (d.prix_achat ?? 0));
      if (delta > 0.02) {
        ecarts_prix.push({
          reference: p.reference,
          designation: p.designation,
          unite_pdf: p.unite,
          unite_db: d.unite,
          prix_pdf: p.prix_achat,
          prix_db: d.prix_achat,
          delta: Math.round(delta * 100) / 100,
          page: p.page,
        });
      }
    }
  }

  for (const [key, d] of indexDB) {
    if (!indexPDF.has(key)) fantomes.push(d);
  }

  return { total_pdf: indexPDF.size, manquants, fantomes, ecarts_prix };
}
