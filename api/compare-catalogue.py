import os
import json
import csv
import io
import anthropic
from supabase import create_client
from http.server import BaseHTTPRequestHandler

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
ANTHROPIC_KEY = os.environ["ANTHROPIC_API_KEY"]

BUCKET = "artisan-documents"
EXTRACTION_PATH = "extraction"
SONNET = "claude-haiku-4-5-20251001"
CHUNK_SIZE = 20


class handler(BaseHTTPRequestHandler):

    def do_OPTIONS(self):
        self._cors()
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length))
        import_id = body.get("import_id")
        if not import_id:
            self._json({"error": "import_id requis"}, 400)
            return

        try:
            db = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
            ai = anthropic.Anthropic(api_key=ANTHROPIC_KEY)

            imp = db.from_("catalogue_imports").select("statut, artisan_id, fournisseur_id").eq("id", import_id).single().execute()
            if not imp.data:
                self._json({"error": "Import introuvable"}, 404)
                return

            statut = imp.data["statut"]

            storage_path = f"{EXTRACTION_PATH}/{import_id}.csv"
            try:
                csv_bytes = db.storage.from_(BUCKET).download(storage_path)
            except Exception:
                self._json({"error": "Fichier d'extraction introuvable. Lancez d'abord l'extraction texte."}, 400)
                return

            csv_text = csv_bytes.decode("utf-8-sig")
            reader = csv.DictReader(io.StringIO(csv_text), delimiter=";")
            headers = [h.lower().strip() for h in (reader.fieldnames or [])]

            if is_structured_csv(headers):
                produits_source = parse_structured_csv(csv_text)
                extraction_method = "csv_structure"
            else:
                produits_source = extract_from_text_csv(csv_text, ai)
                extraction_method = "csv_texte_claude"

            if statut == "termine":
                db_resp = db.from_("produits").select("id, reference, designation, unite, prix_achat").eq("import_id", import_id).eq("actif", True).execute()
                produits_db = db_resp.data or []

                result = compare(produits_source, produits_db)
                result["total_db"] = len(produits_db)
                result["extraction_method"] = extraction_method
                result["mode"] = "comparaison"
                self._json(result)

            else:
                result = {
                    "mode": "import",
                    "extraction_method": extraction_method,
                    "total_source": len(produits_source),
                    "articles": produits_source,
                }
                self._json(result)

        except Exception as e:
            self._json({"error": str(e)}, 500)

    def _cors(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "content-type, authorization")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Content-Type", "application/json")

    def _json(self, data, status=200):
        self._cors()
        body = json.dumps(data).encode()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def is_structured_csv(headers: list) -> bool:
    required = {"designation", "prix_achat"}
    return required.issubset(set(headers))


def parse_structured_csv(csv_text: str) -> list:
    reader = csv.DictReader(io.StringIO(csv_text), delimiter=";")
    headers = [h.lower().strip() for h in (reader.fieldnames or [])]

    def col(*names):
        for n in names:
            for h in headers:
                if n in h:
                    return h
        return None

    ref_col = col("ref", "reference", "code", "article")
    des_col = col("designation", "désignation", "libellé", "nom")
    u_col = col("unite", "unité")
    p_col = col("prix_achat", "prix", "pa", "tarif")

    if not des_col:
        return []

    result = []
    for row in reader:
        des = row.get(des_col, "").strip()
        if not des:
            continue
        try:
            pa = float(row.get(p_col, "0").replace(",", ".")) if p_col else 0.0
        except ValueError:
            pa = 0.0
        result.append({
            "reference": row.get(ref_col, "").strip() or None if ref_col else None,
            "designation": des,
            "unite": row.get(u_col, "u").strip() or "u" if u_col else "u",
            "prix_achat": max(0.0, pa),
            "page": None,
        })
    return result


def extract_from_text_csv(csv_text: str, ai: anthropic.Anthropic) -> list:
    reader = csv.DictReader(io.StringIO(csv_text), delimiter=";")
    rows = list(reader)

    pages: dict = {}
    for row in rows:
        try:
            page = int(row.get("page") or 0)
        except ValueError:
            page = 0
        texte = (row.get("texte") or "").strip()
        if texte:
            pages.setdefault(page, []).append(texte)

    pages_text = [(p, "\n\n".join(blocs)) for p, blocs in sorted(pages.items()) if blocs]

    all_produits = []
    for i in range(0, len(pages_text), CHUNK_SIZE):
        chunk_pages = pages_text[i:i + CHUNK_SIZE]
        chunk = "\n\n---\n\n".join(f"=== PAGE {n} ===\n{t}" for n, t in chunk_pages)
        all_produits.extend(call_claude_text(chunk, ai))

    return deduplicate_smart(all_produits)


def call_claude_text(text: str, ai: anthropic.Anthropic) -> list:
    prompt = f"""Extrais TOUS les produits de ce texte de catalogue fournisseur sans en omettre aucun.
Pour chaque produit : référence article, désignation complète, unité de vente, prix HT en euros, numéro de page.
Réponds UNIQUEMENT en JSON compact sur une seule ligne, sans aucun texte avant ou après :
{{"p":[{{"r":"ref_ou_null","d":"designation","u":"unite","pa":0.00,"pg":1}}]}}
Règles :
- r=null si absent, u="u" si absente, pa=0 si absent, pg=numéro de la section === PAGE N === où le produit apparaît.
- VARIANTES PAR CLASSE : si un article a plusieurs prix selon une classe (VENERE/AMBRA/TERRA/LUCE/FREE/CLASSIC/ANTIQUE/WIDE), extraire UN article par prix. Concaténer code + variante dans r (ex: "U11 FREE", "U11 CLASSIC", "U11 VENERE").
- TABLEAUX MULTI-COLONNES : quand des colonnes ont des noms de format/dimension (ex: LAMPARQUET, EXTRALAMP, LISTOLAMP, ATENE, LISTONI), une ligne avec N prix = N articles distincts. Construire r avec essence+grade+colonne (ex: r="Chêne Roble VENERE LAMPARQUET" pa=77.00 ; r="Chêne Roble VENERE EXTRALAMP" pa=108.70). Ignorer les cellules tiret (-).
- MÊME RÉFÉRENCE SUR PAGES DIFFÉRENTES avec prix différents = produits distincts. Inclure le nom de la collection visible sur la page (Dimora, Decora, Uniko, Residence, Carpazi, Tavola3strati...) dans d pour les différencier.
- DÉCLINAISONS DE TAILLE/DIMENSION : si un tableau liste le même modèle en plusieurs dimensions (ex: 100x13mm, 120x13mm, 140x13mm), extraire UN article par dimension avec la dimension dans d. Ne jamais fusionner plusieurs dimensions en une seule ligne.
- Extraire TOUTES les lignes ayant un prix, y compris forfaits, suppléments, surcoûts, colles, accessoires.
- LANGUE : si une page contient des blocs de texte purement en espagnol ou en italien (phrases entières avec mots comme madera, rastreles, zocalo, barnizado, acabado, espesor, ancho, largo, epossipoliuretanico, silanico, ipoallergenico, sottofondi), ignorer ces blocs et ne pas les extraire en doublon. ATTENTION : ne pas confondre avec les noms commerciaux de couleurs et finitions qui utilisent des mots italiens (Acqua Neutro, Bianco Neve, Naturalizzato, Piallato, Cognac, Clif, Sabbia, etc.) — ceux-ci font partie de la désignation française et doivent être extraits normalement.

TEXTE DU CATALOGUE :
{text}"""

    resp = ai.messages.create(
        model=SONNET,
        max_tokens=8192,
        messages=[{"role": "user", "content": prompt}]
    )
    return parse_ai(resp.content[0].text or "")


def parse_ai(text: str) -> list:
    import re
    text = text.strip()
    start = text.find("{")
    end = text.rfind("}") + 1
    if start == -1:
        return []
    try:
        parsed = json.loads(text[start:end])
        items = parsed.get("p", [])
        return [normalize(i) for i in items if normalize(i).get("designation")]
    except Exception:
        pass
    result = []
    for m in re.finditer(r'\{[^{}]+\}', text):
        try:
            p = normalize(json.loads(m.group()))
            if p.get("designation"):
                result.append(p)
        except Exception:
            pass
    return result


def normalize(obj: dict) -> dict:
    raw = obj.get("pa") or obj.get("prix_achat") or 0
    try:
        pa = float(raw)
    except (ValueError, TypeError):
        pa = 0.0
    ref = obj.get("r") or obj.get("reference") or None
    try:
        pg = int(obj.get("pg") or obj.get("page") or 0)
    except (ValueError, TypeError):
        pg = 0
    return {
        "reference": str(ref).strip() if ref else None,
        "designation": str(obj.get("d") or obj.get("designation") or "").strip(),
        "unite": str(obj.get("u") or obj.get("unite") or "u").strip() or "u",
        "prix_achat": max(0.0, pa),
        "page": pg if pg > 0 else None,
    }


def deduplicate_smart(produits: list) -> list:
    seen = set()
    result = []
    for p in produits:
        ref = (p.get("reference") or "").strip().lower()
        des = (p.get("designation") or "").strip().lower()
        unite = (p.get("unite") or "").strip().lower()
        prix_cents = int(round((p.get("prix_achat") or 0) * 100))
        page = p.get("page") or 0
        key = f"{ref}|{des}|{unite}|{prix_cents}|{page}"
        if key not in seen:
            seen.add(key)
            result.append(p)
    return result


def build_index(produits: list) -> dict:
    index = {}
    for p in produits:
        ref = (p.get("reference") or "").strip().lower()
        des = (p.get("designation") or "").strip().lower()[:40]
        key = ref if ref else des
        if key:
            index[key] = p
    return index


def deduplicate(produits: list) -> list:
    seen = set()
    result = []
    for p in produits:
        key = f"{p.get('reference') or ''}|{p.get('designation', '').lower()}"
        if key not in seen:
            seen.add(key)
            result.append(p)
    return result


def compare(produits_source: list, produits_db: list) -> dict:
    pdf_dedup = deduplicate(produits_source)
    index_pdf = build_index(pdf_dedup)
    index_db = build_index(produits_db)

    manquants, fantomes, ecarts_prix = [], [], []

    for key, p in index_pdf.items():
        if key not in index_db:
            manquants.append(p)
        else:
            d = index_db[key]
            delta = abs((p.get("prix_achat") or 0) - (d.get("prix_achat") or 0))
            if delta > 0.02:
                ecarts_prix.append({
                    "reference": p.get("reference"),
                    "designation": p.get("designation"),
                    "unite_pdf": p.get("unite"),
                    "unite_db": d.get("unite"),
                    "prix_pdf": p.get("prix_achat"),
                    "prix_db": d.get("prix_achat"),
                    "delta": round(delta, 2),
                    "page": p.get("page"),
                })

    for key, d in index_db.items():
        if key not in index_pdf:
            fantomes.append(d)

    return {
        "total_pdf": len(index_pdf),
        "manquants": manquants,
        "fantomes": fantomes,
        "ecarts_prix": ecarts_prix,
    }
