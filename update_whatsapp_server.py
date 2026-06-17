import os
import re
import json

ROOT = os.getcwd()


def read_file(rel_path):
    with open(os.path.join(ROOT, rel_path), 'r', encoding='utf-8') as f:
        return f.read()


def write_file(rel_path, content):
    with open(os.path.join(ROOT, rel_path), 'w', encoding='utf-8') as f:
        f.write(content)
    print(f"[OK] wrote {rel_path}")


def replace_in_file(rel_path, old, new):
    content = read_file(rel_path)
    if old not in content:
        print(f"[WARN] exact pattern not found in {rel_path}, skipping this replace")
        return
    if content.count(old) > 1:
        print(f"[WARN] pattern appears more than once in {rel_path}, replacing first occurrence only")
    content = content.replace(old, new, 1)
    write_file(rel_path, content)


# ── 1) server.js: swap Anthropic AI block for FAQ keyword-matching ───────
server_content = read_file('server.js')

faq_block = """// ===== FAQ Auto-Reply =====
async function findFaqReply(companyId, messageText) {
  try {
    const { rows } = await pool.query(
      'SELECT keyword, answer FROM "WhatsappFaq" WHERE "companyId" = $1 ORDER BY "createdAt" ASC',
      [companyId]
    );
    const lowerText = (messageText || '').toLowerCase();
    for (const row of rows) {
      if (row.keyword && lowerText.includes(row.keyword.toLowerCase())) {
        return row.answer;
      }
    }
    return null;
  } catch (e) {
    console.error('FAQ lookup error:', e);
    return null;
  }
}

"""

ai_block_pattern = re.compile(
    r"// ===== AI Auto-Reply =====.*?(?=// ===== Company sessions storage =====)",
    re.DOTALL,
)
new_server_content, n = ai_block_pattern.subn(faq_block, server_content)
if n != 1:
    print(f"[WARN] AI Auto-Reply block pattern matched {n} time(s), expected 1 — server.js left unchanged for this step")
else:
    server_content = new_server_content
    print("[OK] replaced AI Auto-Reply block with FAQ Auto-Reply block")

write_file('server.js', server_content)

# Add the pg Pool setup right after the existing requires
replace_in_file(
    'server.js',
    "const qrcode = require('qrcode');\n\nconst app = express();\napp.use(cors());\napp.use(express.json());\n",
    "const qrcode = require('qrcode');\nconst { Pool } = require('pg');\n\nconst app = express();\napp.use(cors());\napp.use(express.json());\n\nconst pool = new Pool({\n  connectionString: process.env.DATABASE_URL,\n  ssl: { rejectUnauthorized: false },\n});\n",
)

# Swap the call site inside messages.upsert
replace_in_file(
    'server.js',
    "    const reply = await getAIReply(text, sessions[companyId].companyName);\n\n    await socket.sendMessage(jid, { text: reply });\n    console.log(`[${companyId}] Replied: ${reply}`);\n",
    "    const reply = await findFaqReply(companyId, text);\n    if (!reply) return;\n\n    await socket.sendMessage(jid, { text: reply });\n    console.log(`[${companyId}] Auto-replied: ${reply}`);\n",
)

# ── 2) package.json: drop unused deps, add pg ─────────────────────────────
pkg_path = os.path.join(ROOT, 'package.json')
with open(pkg_path, 'r', encoding='utf-8') as f:
    pkg = json.load(f)

deps = pkg.get('dependencies', {})
removed = []
for unused in ('whatsapp-web.js', 'socket.io'):
    if unused in deps:
        del deps[unused]
        removed.append(unused)
deps['pg'] = '^8.13.1'
pkg['dependencies'] = deps

with open(pkg_path, 'w', encoding='utf-8') as f:
    json.dump(pkg, f, indent=2)
    f.write('\n')

print(f"[OK] patched package.json (removed: {removed or 'none'}, added: pg)")

print("\nDone! Next steps:")
print("1) npm install")
print("2) make sure DATABASE_URL is set in your .env (same Neon connection string as tijara-saas)")
print("3) node --check server.js   (quick syntax check)")
print("4) git add . && git commit -m \"feat: FAQ-based auto-reply instead of paid Anthropic AI\" && git push")
print("5) on Railway: set DATABASE_URL env var for this service, then deploy")
