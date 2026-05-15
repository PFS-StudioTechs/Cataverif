import os
import json
import base64
import io
import fitz  # PyMuPDF
import anthropic
from supabase import create_client
from http.server import BaseHTTPRequestHandler

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
ANTHROPIC_KEY = os.environ["ANTHROPIC_API_KEY"]

BUCKET = "artisan-documents"
SONNET = "claude-sonnet-4-6"


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

            imp = db.from_("catalogue_imports").select("fichier_url, fichier_type").eq("id", import_id).single().execute()
            if not imp.data:
                self._json({"error": "Import introuvable"}, 404)
                return

            fichier_url = imp.data["fichier_url"]
            fichier_type = imp.data["fichier_type"]

            if fichier_type != "pdf":
                self._json({"error": "Extraction images disponible pour PDF uniquement"}, 400)
                return

            file_resp = db.storage.from_(BUCKET).download(fichier_url)
            pdf_bytes = file_resp

            produits_resp = db.from_("produits").select("id, reference, designation").eq("import_id", import_id).eq("actif", True).execute()
            produits = produits_resp.data or []

            ref_index = {(p["reference"] or "").strip().lower(): p["id"] for p in produits if p["reference"]}

            doc = fitz.open(stream=pdf_bytes, filetype="pdf")
            ai = anthropic.Anthropic(api_key=ANTHROPIC_KEY)

            updated = 0

            for page_num in range(len(doc)):
                page = doc[page_num]
                image_list = page.get_images(full=True)
                if not image_list:
                    continue

                page_png = page.get_pixmap(dpi=120).tobytes("png")
                page_b64 = base64.b64encode(page_png).decode()

                refs_on_page = [p["reference"] for p in produits if p["reference"]]

                prompt = f"""Cette page d'un catalogue fournisseur contient des photos de produits.
Pour chaque image de produit visible, identifie la référence article la plus proche dans la liste suivante :
{json.dumps(refs_on_page[:80])}

Réponds UNIQUEMENT en JSON sur une seule ligne :
{{"associations": [{{"ref": "XXXXX", "image_index": 0}}]}}
- image_index = index de l'image dans l'ordre d'apparition sur la page (0, 1, 2...)
- Inclus uniquement les associations certaines (image clairement liée à un produit identifiable)
- Si aucune association certaine, réponds {{"associations": []}}"""

                resp = ai.messages.create(
                    model=SONNET,
                    max_tokens=1024,
                    messages=[{
                        "role": "user",
                        "content": [
                            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": page_b64}},
                            {"type": "text", "text": prompt}
                        ]
                    }]
                )

                text = (resp.content[0].text or "").strip()
                start = text.find("{")
                end = text.rfind("}") + 1
                if start == -1:
                    continue

                try:
                    result = json.loads(text[start:end])
                    associations = result.get("associations", [])
                except Exception:
                    continue

                for assoc in associations:
                    ref = str(assoc.get("ref", "")).strip().lower()
                    img_idx = assoc.get("image_index", 0)
                    produit_id = ref_index.get(ref)
                    if not produit_id or img_idx >= len(image_list):
                        continue

                    xref = image_list[img_idx][0]
                    base_image = doc.extract_image(xref)
                    img_bytes = base_image["image"]
                    ext = base_image["ext"]

                    storage_path = f"product-images/{import_id}/{ref}.{ext}"
                    db.storage.from_(BUCKET).upload(
                        storage_path,
                        img_bytes,
                        {"content-type": f"image/{ext}", "upsert": "true"}
                    )

                    public = db.storage.from_(BUCKET).get_public_url(storage_path)
                    db.from_("produits").update({"image_url": public}).eq("id", produit_id).execute()
                    updated += 1

            doc.close()
            self._json({"updated": updated})

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
