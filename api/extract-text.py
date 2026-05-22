import os
import io
import csv
import json
import fitz
from supabase import create_client
from http.server import BaseHTTPRequestHandler

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
BUCKET = "artisan-documents"
EXTRACTION_PATH = "extraction"


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
                self._json({"error": "Extraction texte disponible uniquement pour les PDF"}, 400)
                return

            file_bytes = db.storage.from_(BUCKET).download(fichier_url)

            csv_bytes = extract_to_csv(file_bytes)

            storage_path = f"{EXTRACTION_PATH}/{import_id}.csv"
            db.storage.from_(BUCKET).upload(
                storage_path,
                csv_bytes,
                {"content-type": "text/csv; charset=utf-8", "upsert": "true"},
            )

            signed = db.storage.from_(BUCKET).create_signed_url(storage_path, 300)
            url = signed.get("signedURL") or signed.get("signedUrl") or ""

            nb_blocs = csv_bytes.decode("utf-8-sig").count("\n") - 1
            self._json({"url": url, "storage_path": storage_path, "nb_blocs": nb_blocs})

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


def extract_to_csv(file_bytes: bytes) -> bytes:
    doc = fitz.open(stream=file_bytes, filetype="pdf")
    output = io.StringIO()
    writer = csv.writer(output, delimiter=";", quoting=csv.QUOTE_MINIMAL)
    writer.writerow(["page", "texte"])

    for page_num, page in enumerate(doc, start=1):
        blocks = page.get_text("blocks")
        text_blocks = [
            b[4].strip()
            for b in blocks
            if b[6] == 0 and b[4].strip()
        ]
        if not text_blocks:
            words = page.get_text("words")
            if words:
                words_sorted = sorted(words, key=lambda w: (w[1], w[0]))
                lines, current_line, current_y = [], [], None
                for w in words_sorted:
                    y0, word = w[1], w[4]
                    if current_y is None or abs(y0 - current_y) > 5:
                        if current_line:
                            lines.append(" ".join(current_line))
                        current_line, current_y = [word], y0
                    else:
                        current_line.append(word)
                if current_line:
                    lines.append(" ".join(current_line))
                if lines:
                    text_blocks = ["\n".join(lines)]

        for bloc in text_blocks:
            writer.writerow([page_num, bloc])

    doc.close()
    return ("﻿" + output.getvalue()).encode("utf-8")
