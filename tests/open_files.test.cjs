/** Open access, Office files (xlsx/docx/pptx), files remembered for follow-ups. `npm test` (no network). */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { zipSync, strToU8 } = require("fflate");

const { check, chatAllowed } = require("../src/access.js");
const docs = require("../src/documents.js");
const { Store, RateLimiter } = require("../src/state.js");
const { Bot } = require("../src/bot.js");
const { TelegramClient } = require("../src/telegram.js");
const { SnapshotStore } = require("../src/snapshots.js");
const { PROJECTS } = require("../src/projects.js");
const cfgMod = require("../src/config.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gqo-"));
const zip = (files) => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));

const XLSX = zip({
  "xl/workbook.xml": `<workbook xmlns:r="r"><sheets><sheet name="Holdings" sheetId="1" r:id="rId1"/><sheet name="Notes &amp; Misc" sheetId="2" r:id="rId2"/><sheet name="Empty" sheetId="3" r:id="rId3"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Target="worksheets/sheet3.xml"/></Relationships>`,
  "xl/sharedStrings.xml": `<sst><si><t>Company</t></si><si><t>Qty</t></si><si><t>HDFC Bank</t></si><si><r><t>Info</t></r><r><t>sys, Ltd</t></r></si></sst>`,
  "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>120</v></c></row><row r="3"><c r="A3" t="s"><v>3</v></c><c r="C3" t="b"><v>1</v></c></row></sheetData></worksheet>`,
  "xl/worksheets/sheet2.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Review &lt;Q2&gt;</t></is></c></row></sheetData></worksheet>`,
  "xl/worksheets/sheet3.xml": `<worksheet><sheetData/></worksheet>`,
});
const DOCX = zip({ "word/document.xml": `<w:document><w:body><w:p><w:r><w:t>Quarterly note</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Revenue</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>₹1,200 cr</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t xml:space="preserve">Margins </w:t></w:r><w:r><w:t>improved &amp; held.</w:t></w:r></w:p></w:body></w:document>` });
const PPTX = zip({ "ppt/slides/slide2.xml": `<p:sld><a:p><a:r><a:t>Outlook</a:t></a:r></a:p></p:sld>`, "ppt/slides/slide10.xml": `<p:sld><a:p><a:r><a:t>Appendix</a:t></a:r></a:p></p:sld>`, "ppt/slides/slide1.xml": `<p:sld><a:p><a:r><a:t>Title</a:t></a:r></a:p><a:p><a:r><a:t>GQuants</a:t></a:r></a:p></p:sld>` });

test("access: with no lists set, anyone can use the bot in DMs and in any group, and everyone may do admin things", () => {
  const cfg = cfgMod.load({ TELEGRAM_BOT_TOKEN: "1:x" });
  assert.deepEqual(check(cfg, { chat: { id: 5, type: "private" }, from: { id: 5 } }), { ok: true, admin: true });
  assert.deepEqual(check(cfg, { chat: { id: -100, type: "supergroup" }, from: { id: 7 } }), { ok: true, admin: true });
  assert.equal(check(cfg, { chat: { id: 5, type: "private" }, from: { id: 5, is_bot: true } }).ok, false, "other bots are still ignored");
  assert.equal(check(cfg, { chat: { id: -1, type: "channel" }, from: { id: 5 } }).ok, false);
  assert.equal(chatAllowed(cfg, "-100"), true); assert.equal(chatAllowed(cfg, "5"), true);
  const locked = cfgMod.load({ TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_ALLOWED_USER_IDS: "5", TELEGRAM_ADMIN_USER_IDS: "9" });
  assert.equal(check(locked, { chat: { id: 6, type: "private" }, from: { id: 6 } }).ok, false, "setting the list still restricts");
  assert.equal(check(locked, { chat: { id: 5, type: "private" }, from: { id: 5 } }).admin, false);
  assert.equal("briefChatId" in cfgMod.load({}), false, "no brief variables any more");
});

test("files: Excel becomes one table per sheet (shared strings, inline strings, gaps, booleans); empty sheets dropped", async () => {
  const sheets = docs.xlsxSheets(XLSX);
  assert.deepEqual(sheets.map((s) => s.name), ["Holdings", "Notes & Misc"]);
  assert.equal(sheets[0].csv, 'Company,Qty\nHDFC Bank,120\n"Infosys, Ltd",,TRUE');
  assert.equal(sheets[1].csv, "Review <Q2>");
  const all = await docs.extractAll({ name: "book.xlsx", buf: XLSX });
  assert.deepEqual(all.map((d) => [d.name, d.kind]), [["book.xlsx [Holdings]", "csv"], ["book.xlsx [Notes & Misc]", "csv"]]);
  const t = docs.analyzeTable(all[0].text);
  assert.equal(t.rows, 2);
  await assert.rejects(() => docs.extractAll({ name: "bad.xlsx", buf: Buffer.from("not a zip") }), /could not open this Excel file/);
});

test("files: Word paragraphs and tables, PowerPoint slides in numeric order", async () => {
  const d = await docs.extract({ name: "note.docx", buf: DOCX });
  assert.equal(d.text, "Quarterly note\nRevenue | ₹1,200 cr\nMargins improved & held.");
  const p = await docs.extract({ name: "deck.pptx", buf: PPTX });
  assert.equal(p.text, "--- slide 1 ---\nTitle\nGQuants\n\n--- slide 2 ---\nOutlook\n\n--- slide 3 ---\nAppendix");
  assert.match(p.note, /slide text only/);
  assert.equal(docs.kindOf("x.xlsx"), "xlsx"); assert.equal(docs.kindOf("a", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "docx");
  assert.equal(docs.kindOf("old.xls"), null);
});

function world() {
  const cfg = cfgMod.load({ TELEGRAM_BOT_TOKEN: "1:x", DATA_DIR: tmp(), AGENT_RATE_PER_MIN: "100" });
  const sent = [];
  const fileBytes = { X1: XLSX, D1: DOCX };
  const f = async (url, o = {}) => {
    const u = new URL(url); const method = u.pathname.split("/").pop();
    if (u.pathname.includes("/file/")) return new Response(fileBytes[method]);
    const body = o.body ? JSON.parse(o.body) : {};
    if (method === "getFile") return new Response(JSON.stringify({ ok: true, result: { file_path: body.file_id, file_size: 100 } }));
    if (method === "sendMessage") sent.push(body);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 900 + sent.length } }));
  };
  const tg = new TelegramClient({ token: "1:x", fetchImpl: f, log: () => {} });
  const prompts = [];
  const provider = { name: "fake", model: "m", chat: async (a) => { prompts.push(a); return { text: "ok", toolCalls: [], usage: { in: 1, out: 1 } }; } };
  const bot = new Bot({ cfg, tg, provider, store: new Store(cfg.dataDir, () => {}), snapshots: new SnapshotStore({ projects: PROJECTS, log: () => {} }), live: {}, limiter: new RateLimiter(100), log: () => {} });
  bot.me = { id: 999, username: "gq_agent_bot" };
  return { bot, sent, prompts };
}
const dm = (over) => ({ message_id: 5, chat: { id: 4242, type: "private" }, from: { id: 4242, first_name: "New person" }, ...over });

test("bot: a stranger can use it straight away; files sent are read and stay available for follow-up questions until /new", async () => {
  const w = world();
  await w.bot.handle({ update_id: 1, message: dm({ text: "/start" }) });
  assert.match(w.sent.at(-1).text, /Hi! I'm the GQuants Assistant/, "no access list needed");
  await w.bot.handle({ update_id: 2, message: dm({ document: { file_id: "X1", file_name: "holdings.xlsx", file_size: 100 } }) });
  const first = w.prompts.at(-1);
  assert.match(first.messages.at(-1).content, /short summary of what it is/);
  assert.match(first.system, /holdings\.xlsx \[Holdings\] \(csv/);
  assert.ok(first.tools.some((t) => t.name === "analyze_table"), "Excel sheets can be analysed exactly");
  await w.bot.handle({ update_id: 3, message: dm({ document: { file_id: "D1", file_name: "note.docx", file_size: 100 }, caption: "compare with the Excel" }) });
  assert.match(w.prompts.at(-1).system, /holdings\.xlsx \[Holdings\][\s\S]*note\.docx/, "both files available together");
  await w.bot.handle({ update_id: 4, message: dm({ text: "what's the total quantity?" }) });
  assert.match(w.prompts.at(-1).system, /holdings\.xlsx \[Holdings\]/, "follow-up still sees the file");
  await w.bot.handle({ update_id: 5, message: dm({ text: "/new" }) });
  assert.match(w.sent.at(-1).text, /forgotten our earlier messages and files/);
  await w.bot.handle({ update_id: 6, message: dm({ text: "hello" }) });
  assert.doesNotMatch(w.prompts.at(-1).system, /holdings\.xlsx/);
});
