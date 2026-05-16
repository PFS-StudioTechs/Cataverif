import os
import json
import csv
import io
import fitz
import anthropic
from supabase import create_client
from http.server import BaseHTTPRequestHandler

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
ANTHROPIC_KEY = os.environ["ANTHROPIC_API_KEY"]

BUCKET = "artisan-documents"
SONNET = "claude-sonnet-4-6"
PAGES_PER_CHUNK = 10


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

            imp = db.from_("catalogue_imports").select("fichier_url, fichier_type, artisan_id").eq("id", import_id).single().execute()
            if not imp.data:
                self._json({"error": "Import introuvable"}, 404)
                return

            fichier_url = imp.data["fichier_url"]
            fichier_type = imp.data["fichier_type"]

            file_bytes = db.storage.from_(BUCKET).download(fichier_url)

            if fichier_type == "csv":
                produits_pdf = parse_csv(file_bytes)
                extraction_method = "csv"
            elif fichier_type == "pdf":
                produits_pdf = extract_pdf(file_bytes, ai)
                extraction_method = "pdf_text_sonnet"
            else:
                produits_pdf = extract_image(file_bytes, ai)
                extraction_method = "image_sonnet"

            db_resp = db.from_("produits").select("reference, designation, unite, prix_achat, prix_negocie").eq("import_id", import_id).eq("actif", True).execute()
            produits_db = db_resp.data or []

            result = compare(produits_pdf, produits_db)
            result["total_db"] = len(produits_db)
            result["extraction_method"] = extraction_method

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


def page_to_ordered_text(page) -> str:
    words = page.get_text("words")
    if not words:
        return ""
    words_sorted = sorted(words, key=lambda w: (w[1], w[0]))
    lines = []
    current_line_words = []
    current_y = None
    for w in words_sorted:
        y0, word = w[1], w[4]
        if current_y is None or abs(y0 - current_y) > 5:
            if current_line_words:
                lines.append(" ".join(current_line_words))
            current_line_words = [word]
            current_y = y0
        else:
            current_line_words.append(word)
    if current_line_words:
        lines.append(" ".join(current_line_words))
    return "\n".join(lines)


def extract_pdf(file_bytes: bytes, ai: anthropic.Anthropic) -> list:
    doc = fitz.open(stream=file_bytes, filetype="pdf")
    pages_text = []
    for page_num, page in enumerate(doc, start=1):
        text = page_to_ordered_text(page)
        if text:
            pages_text.append((page_num, text))
    doc.close()

    if not pages_text:
        return []

    produits = []
    for i in range(0, len(pages_text), PAGES_PER_CHUNK):
        chunk_pages = pages_text[i:i + PAGES_PER_CHUNK]
        chunk = "\n\n---\n\n".join(f"=== PAGE {n} ===\n{t}" for n, t in chunk_pages)
        produits.extend(call_claude_text(chunk, ai))

    return deduplicate(produits)


def call_claude_text(text: str, ai: anthropic.Anthropic) -> list:
    prompt = f"""Extrais TOUS les produits de ce texte de catalogue fournisseur sans en omettre aucun.
Pour chaque produit : référence article, désignation complète, unité de vente, prix HT en euros, numéro de page.
Réponds UNIQUEMENT en JSON compact sur une seule ligne, sans aucun texte avant ou après :
{{"p":[{{"r":"ref_ou_null","d":"designation","u":"unite","pa":0.00,"pg":1}}]}}
Règles : r=null si absent, u="u" si absente, pa=0 si absent, pg=numéro de la section === PAGE N === où le produit apparaît.

TEXTE DU CATALOGUE :
{text}"""

    resp = ai.messages.create(
        model=SONNET,
        max_tokens=8192,
        messages=[{"role": "user", "content": prompt}]
    )
    return parse_ai(resp.content[0].text or "")


def extract_image(file_bytes: bytes, ai: anthropic.Anthropic) -> list:
    import base64
    b64 = base64.b64encode(file_bytes).decode()
    prompt = """Extrais TOUS les produits de ce catalogue fournisseur sans en omettre aucun.
Pour chaque produit : référence article, désignation complète, unité de vente, prix HT en euros.
Réponds UNIQUEMENT en JSON compact sur une seule ligne :
{"p":[{"r":"ref_ou_null","d":"designation","u":"unite","pa":0.00}]}"""

    resp = ai.messages.create(
        model=SONNET,
        max_tokens=8192,
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b64}},
            {"type": "text", "text": prompt}
        ]}]
    )
    return parse_ai(resp.content[0].text or "")


def parse_csv(file_bytes: bytes) -> list:
    text = file_bytes.decode("utf-8", errors="replace")
    lines = [l for l in text.splitlines() if l.strip()]
    if len(lines) < 2:
        return []
    sep = ";" if ";" in lines[0] else ","
    reader = csv.DictReader(io.StringIO(text), delimiter=sep)
    headers = [h.lower().strip() for h in (reader.fieldnames or [])]

    def col(*names):
        for n in names:
            for h in headers:
                if n in h:
                    return h
        return None

    ref_col = col("ref", "code", "article")
    des_col = col("désignation", "designation", "libellé", "nom")
    u_col = col("unité", "unite")
    p_col = col("prix", "pa", "tarif")

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
        })
    return result


def parse_ai(text: str) -> list:
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
    import re
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


def deduplicate(produits: list) -> list:
    seen = set()
    result = []
    for p in produits:
        key = f"{p.get('reference') or ''}|{p.get('designation', '').lower()}"
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


def compare(produits_pdf: list, produits_db: list) -> dict:
    pdf_dedup = deduplicate(produits_pdf)
    index_pdf = build_index(pdf_dedup)
    index_db = build_index(produits_db)

    manquants = []
    fantomes = []
    ecarts_prix = []
    prix_negocie = []

    for key, p in index_pdf.items():
        if key not in index_db:
            manquants.append(p)
        else:
            d = index_db[key]
            delta = abs((p.get("prix_achat") or 0) - (d.get("prix_achat") or 0))
            if delta > 0.02:
                ecart = {
                    "reference": p.get("reference"),
                    "designation": p.get("designation"),
                    "unite_pdf": p.get("unite"),
                    "unite_db": d.get("unite"),
                    "prix_pdf": p.get("prix_achat"),
                    "prix_db": d.get("prix_achat"),
                    "delta": round(delta, 2),
                    "page": p.get("page"),
                }
                if d.get("prix_negocie"):
                    prix_negocie.append(ecart)
                else:
                    ecarts_prix.append(ecart)

    for key, d in index_db.items():
        if key not in index_pdf:
            fantomes.append(d)

    return {
        "total_pdf": len(index_pdf),
        "manquants": manquants,
        "fantomes": fantomes,
        "ecarts_prix": ecarts_prix,
        "prix_negocie": prix_negocie,
    }
