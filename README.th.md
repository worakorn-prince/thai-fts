# thai-fts

**การค้นหาแบบข้อความเต็ม (full-text search) ภาษาไทยที่คำนึงถึงวรรณยุกต์ สำหรับ Node.js — ไม่มีการพึ่งพาไลบรารีอื่นตอนรันไทม์ (zero runtime dependencies)**

`thai-fts` แก้ปัญหาสองอย่างที่เสิร์ชเอนจินทั่วไปจัดการภาษาไทยได้ไม่ดี:

1. **ภาษาไทยเขียนติดกันโดยไม่มีเว้นวรรคระหว่างคำ** — ใช้ `Intl.Segmenter` (full ICU) ก่อนเป็นหลักในการตัดคำ โดยมีพจนานุกรมในตัว + การเดาแบบพยางค์เป็นทางเลือกสำรองสำหรับรันไทม์แบบ small-icu ดังนั้นเอกสารจึงถูกจัดทำดัชนีเป็นคำที่มีช่องว่างคั่น และคำค้นหาจะถูกแปลงเป็นลำดับคำแบบ phrase ที่เรียงตามลำดับ
2. **วรรณยุกต์มีความสำคัญเชิงความหมาย** — `ติดตั้ง` (install) ต่างจาก `ติดตัง` (พิมพ์วรรณยุกต์ผิด) แชนแนลแบบ strict จะคงวรรณยุกต์ไว้ให้ตรงเป๊ะ ส่วนแชนแนลแบบ loose (ทางเลือก) จะตัดเฉพาะ `่ ้ ๊ ๋ ์ ํ` แล้วช่วย "กู้คืน" ผลลัพธ์ที่ใส่วรรณยุกต์ผิด โดยจัดอันดับ**อยู่ต่ำกว่า**ผลลัพธ์แบบ strict เสมอ ไม่มีทางแซงขึ้นมา

ทุกอย่างทำงานบนบิวด์อินของ Node — `Intl.Segmenter` และ `node:sqlite` (FTS5) ไม่มีเนทีฟโมดูล ไม่มี WASM ไม่มี npm dependencies ตอนรันไทม์

```text
ตัวอย่างโค้ดและวรรณยุกต์:  ติดตั้ง ≠ ติดตัง  (strict)
                           "ติดตั้ง" loose → "ติดตัง" (ทางสำรอง)
```

## คุณสมบัติ

- ✂️ ตัดคำภาษาไทย (`Intl.Segmenter` ก่อน แล้วตามด้วยพจนานุกรม + พยางค์สำรอง)
- 🎵 นโยบายวรรณยุกต์: **strict เป็นหลัก** พร้อมแชนแนล **loose** สำรองที่เปิดได้
- 🔎 ทำดัชนี FTS5 + ค้นหาผ่าน `node:sqlite` (บิวด์อิน) พร้อม tokenizer ที่คำนึงถึงเครื่องหมายวรรณยุกต์
- 🔁 คำพ้องเสียง/ความหมายแบบทับศัพท์ ไทย↔อังกฤษ (`deploy` ↔ `ดีพลอย`)
- 📚 ช่องต่อทะเบียนพจนานุกรม (เพิ่มคำ / คำพ้อง / override ได้ตอนรันไทม์)
- 🔌 อินเทอร์เฟซเอนจินแบบ pluggable พร้อมทะเบียน (`registerEngine` / `createEngine`)
- 📦 รองรับทั้ง ESM และ CJS พร้อม type declarations ไม่มี dependencies ตอนรันไทม์ ใช้ Node ≥ 22.13.0

## ติดตั้ง

```sh
npm install thai-fts
# ต้องใช้ Node 22.13+ (node:sqlite)
```

## เริ่มต้นใช้งานอย่างรวดเร็ว

### ค้นหาข้อความเต็ม (SQLite FTS5 แบบหน่วยความจำ)

```js
import { createFts5Engine } from "thai-fts";

const engine = createFts5Engine({ memory: true });          // tone: "both"

engine.add({ id: "guide", title: "คู่มือติดตั้ง", body: "ขั้นตอนการติดตั้งโปรแกรม" });
engine.add({ id: "billing", title: "ติดตังค่าบริการ", body: "รายเดือน 49 บาท" });

engine.search("ติดตั้ง", { tone: "both" });
// [
//   { id: "guide",  rank: 1, snippet: "ขั้นตอนการติดตั้งโปรแกรม" },  // strict
//   { id: "billing", rank: 2, snippet: "ติดตังค่าบริการ" },          // loose rescue
// ]

engine.close();
```

สัญญาการทำงานของ dual-channel (ค่าเริ่มต้น `tone: "both"`):

- **strict channel** — คำนึงวรรณยุกต์ ตรงเป๊ะ: `ติดตัง` ไม่ชนกับ `ติดตั้ง` เด็ดขาด
- **loose channel** — ตัดวรรณยุกต์ (`looseForm`): คำค้นที่พิมพ์วรรณยุกต์ผิดยังเจอเอกสารที่เขียนถูกได้ แต่**จัดอันดับต่ำกว่า**ผล strict เสมอ และจะไม่ถูกนำขึ้นมาเมื่อผล strict เต็ม `limit` แล้ว

### ใช้เฉพาะส่วน core (ไม่ต้องใช้ฐานข้อมูล)

```js
import { wordTokens, segmentForIndex, looseForm, hasThai, expandSynonyms } from "thai-fts/core";

wordTokens("ติดตั้งโปรแกรม");        // ["ติดตั้ง", "โปรแกรม", …] (Intl.Segmenter)
segmentForIndex("ติดตั้ง");          // " ติด ตั้ง "  เติมช่องว่างระหว่างคำเพื่อทำดัชนี
looseForm("ติดตั้ง");                // "ติดตัง"     ตัดเครื่องหมายวรรณยุกต์ทิ้ง
hasThai("hello");                    // false
expandSynonyms("deploy");            // ["deploy", "ดีพลอย"]
```

## CLI

แพ็กเกจมาพร้อมไบนารี `thai-fts` — ผลลัพธ์แบบข้อความล้วนเหมาะกับการ pipe, `--json` ห่อผลลัพธ์เป็น `{ ok, data }`, รหัสออก `0` = สำเร็จ / `2` = ผิดพลาด

```sh
thai-fts segment "ติดตั้งโปรแกรม"            # คำที่ตัดได้ บรรทัดละหนึ่งคำ
thai-fts loose "ติดตั้ง"                    # -> ติดตัง
thai-fts synonyms deploy                   # -> ดีพลอย
thai-fts check "สวัสดี"                     # -> 1

# คำสั่ง FTS5 แชร์เอนจินเดียวต่อการเรียกใช้หนึ่งครั้ง จึงใช้ :memory: ได้แบบครบวงจร:
thai-fts index "ต้องติดตั้งโปรแกรมใหม่" --id first \
           index "ติดตังค่าบริการ" --id second \
           search "ติดตั้ง" --db :memory:
# first	1	ต้องติดตั้งโปรแกรมใหม่
# second	2	ติดตังค่าบริการ

thai-fts search "ติดตั้ง" --tone strict --db db.sqlite   # เฉพาะแชนแนล strict
thai-fts search "ติดตั้ง" --limit 5 --tone both --db db.sqlite
thai-fts --json search "ติดตั้ง" --db db.sqlite          # { ok: true, data: [...] }
```

รัน `thai-fts --help` เพื่อดูคำสั่งทั้งหมด

## สรุป API

| Subpath | เนื้อหา |
| --- | --- |
| `thai-fts` (root) | ทุกอย่างด้านล่าง บวก `createFts5Engine` |
| `thai-fts/core` | core ภาษาไทยล้วน (ไม่ต้องใช้ DB) |
| `thai-fts/engine` | อินเทอร์เฟซเอนจินค้นหา + ทะเบียน |
| `thai-fts/fts5` | store / search / schema FTS5 บน `node:sqlite` |

### Core — `thai-fts/core`

**การตัดคำ** (`segment.ts`)

- `wordTokens(text)` → `string[]` — คำที่ตัดได้จากข้อความไทย/อังกฤษปนกัน (ตัวพิมพ์เล็กทั้งหมด)
- `segmentForIndex(text)` → `string` — เติมช่องว่างระหว่างคำในรันภาษาไทย (ทำซ้ำแล้วได้ค่าเดิม = idempotent)
- `segmentQueryChunk(chunk)` → `string[]` — คำภายในหนึ่ง chunk ที่คั่นด้วยช่องว่าง
- `hasThai(text)` → `boolean`
- `looseForm(text)` → `string` — ตัดเฉพาะเครื่องหมายระดับวรรณยุกต์ `่ ้ ๊ ๋ ์ ํ` แต่คงสระไว้ครบ

**คำพ้อง** (`synonyms.ts`) — คำพ้องเสียง/ความหมายแบบทับศัพท์ ไทย↔อังกฤษ

- `expandSynonyms(term)` → `string[]` — เทอมต้น + ทุกคู่เทียบเท่าที่รู้จัก
- `expandChunkSynonyms(chunk)` → `string[]` — ขยายทั้ง chunk (ฝั่งคำค้น)
- `expandIndexedText(segmented)` → `string` — เพิ่มรูปคำพ้องลงใน payload เพื่อทำดัชนี (idempotent)

**สร้างคำค้นหา** (`query.ts`) — ตัวสร้าง MATCH expression ที่ใช้กับเอนจินใดก็ได้

- `buildFtsMatch(query)` / `buildLooseFtsMatch(query)` → นิพจน์ MATCH ของ FTS5
- `buildSearchQuery(query, mode?)` → `{ mode, chunks, match, looseMatch }`
- `quoteFtsToken(token)` → token ที่ escape ให้ปลอดภัยสำหรับ FTS5

**นโยบายวรรณยุกต์** (`tone.ts`)

- `resolveToneMode(opts?)` → `"both" | "strict" | "loose"` (ค่าเริ่มต้น `both`)

**พจนานุกรม** (`dictionaries.ts`) — ช่องต่อทะเบียน

- `THAI_DEFAULT_WORDS`, `THAI_DEFAULT_SYNONYMS` (ค่าเริ่มต้นสาย dev/tech ที่เปิดใช้เสมอ)
- `registerThaiDictionary({ id, words?, synonyms?, overrides? })`
- `listDictionaries()`, `clearRegisteredDictionaries()`

### Engine — `thai-fts/engine`

- `ThaiSearchEngine` — `{ add(doc), remove(id), search(query, opts?), close() }`
- `ThaiSearchDoc`, `ThaiSearchResult`, `ThaiEngineOptions`, `ThaiEngineFactory`
- `registerEngine(name, factory)`, `createEngine(name, opts?)`, `listEngines()`, `unregisterAllEngines()`

### FTS5 — `thai-fts/fts5`

- `createFts5Engine({ path?, memory?, tone?, limit?, dictionaries? })` → `ThaiSearchEngine`
- `openFts5Store({ path?, memory?, dictionaries? })` → `{ db, add, remove, update, rebuild, close, get, allRows }`
- `fts5Search(store, query, opts?)` → `ThaiSearchResult[]` (dual-channel พร้อม hook `filter`)
- `FTS5_STRICT_SCHEMA`, `FTS5_LOOSE_SCHEMA` — DDL ที่คำนึงเครื่องหมาย (`unicode61 categories 'L* N* Co M*'`)

## นโยบายวรรณยุกต์

วรรณยุกต์ไทยมีความหมายในเชิงความหมาย (`ติดตั้ง` ≠ `ติดตัง` ที่พิมพ์ผิด) พฤติกรรมเริ่มต้นคือ **strict เป็นหลัก, loose ช่วยเสริม**:

1. **strict** — ดัชนีที่คงวรรณยุกต์ไว้ ตรงเป๊ะและเชื่อถือได้
2. **loose** (ต่อเมื่อผล strict ยังไม่เต็ม `limit`) — `looseForm` ของ payload เดียวกันกับที่ทำดัชนี ตัด id ซ้ำ และจัดอันดับตามหลังผล strict ทั้งหมด

`tone: "strict"` ให้การจับคู่แบบตรงทุกอย่าง `tone: "loose"` ให้การจับคู่แบบตัดวรรณยุกต์เท่านั้น `tone: "both"` (ค่าเริ่มต้น) คือการรวมสองชั้นด้านบน คำค้นภาษาไทยสั้น (1–2 ตัวอักษร) จะใช้การสแกนแบบ LIKE แทน FTS phrase และรายงาน `meta.method: "like_fallback"`

## พจนานุกรม

การลงทะเบียนเป็นการเพิ่มทับบนค่าเริ่มต้นสาย dev/tech ที่มีในตัว (`ติดตั้ง`, `เซิร์ฟเวอร์`, `ฐานข้อมูล`, `deploy` ↔ `ดีพลอย`, …):

```js
import { registerThaiDictionary } from "thai-fts";

registerThaiDictionary({
  id: "my-app",
  words: ["ตากลม"],                                  // บังคับให้เป็นคำเดียว
  synonyms: [["display", "จอภาพ"]],                  // ใช้ได้ทั้งสองทิศทาง
  overrides: [{ term: "โปรเจกต์", fixed: "โปรเจกต์" }],
});
```

## แผนงานอะแดปเตอร์

`ThaiSearchEngine` คือคอนแทรกต์แบบ pluggable ขั้นต่ำ และทะเบียนคือช่องต่อสำหรับแบ็กเอนด์ในอนาคต ปัจจุบัน: `fts5` (อ้างอิง, `node:sqlite`) ต่อไปตามแผน:

- **Meilisearch** / **Elasticsearch** — จับ `add`/`remove`/`search` เข้ากับ REST API ของมัน
- **In-memory** — ดัชนี JS ขนาดเล็กสำหรับเทสต์และเครื่องมือออฟไลน์
- **Vector / hybrid** — ใส่ embeddings เพิ่มเป็นชั้นให้คะแนน โดยยังใช้อินเทอร์เฟซเดิม

```js
import { registerEngine, createEngine } from "thai-fts";

registerEngine("meilisearch", (opts) => new MeiliEngine(opts));
const engine = createEngine("meilisearch", { host: "http://localhost:7700" });
```

## ไม่มี dependencies ตอนรันไทม์

- การตัดคำ: `Intl.Segmenter` (ในตัวของ Node full-icu) + พจนานุกรม/พยางค์สำรอง
- FTS: `node:sqlite` `DatabaseSync` + virtual table FTS5 (ในตัวของ Node ≥ 22.5)
- เทสต์: `node:test`; บิลด์: `tsup` (เฉพาะตอนพัฒนา)

## การพัฒนา

```sh
npm install
npm run build      # tsup -> dist/ (ESM + CJS + d.ts) สำหรับ 4 subpaths
npm test           # build + node --test (docs + CLI + core + FTS5)
npm run pack:check # npm pack --dry-run (จัดส่งเฉพาะ dist + docs + READMEs)
npx tsc --noEmit   # ตรวจชนิด
```

## ลิขสิทธิ์

MIT — ดู [LICENSE](LICENSE)
