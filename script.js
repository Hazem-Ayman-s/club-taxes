"use strict";

/* ========== إعدادات الحساب (عدّلها هنا مستقبلًا) ========== */
const BASE_FEE = 10;                      // قيمة الاشتراك الأساسية لكل سنة
const PENALTY_RATES = [0, 0.5, 1, 2, 3];  // نسبة الغرامة للسنوات 1..5 (السنة 5 وما بعدها تأخذ آخر نسبة)
const COLLECTION = "membership_fines"; // اسم الـ Collection في Firestore
const MAX_YEARS = 1000;

/** نسبة الغرامة لسنة معيّنة (تبدأ من 1) */
function getPenaltyRate(yearNumber) {
  return PENALTY_RATES[Math.min(yearNumber, PENALTY_RATES.length) - 1];
}

/** تفاصيل كل سنة */
function getBreakdown(years) {
  const rows = [];
  for (let y = 1; y <= years; y++) {
    const rate = getPenaltyRate(y);
    rows.push({ year: y, fee: BASE_FEE, rate, total: BASE_FEE * (1 + rate) });
  }
  return rows;
}

/** الدالة الأساسية: إجمالي المبلغ المطلوب لعدد سنوات */
function calculateFine(years) {
  let total = 0;
  for (let y = 1; y <= years; y++) total += BASE_FEE * (1 + getPenaltyRate(y));
  return total;
}

/* ========== الحالة والتخزين ========== */
let records = [];
let searchTerm = "";
let editingId = null;
let deletingId = null;

/* ========== Firestore ========== */
const col = () => db.collection(COLLECTION);

/** جلب كل السجلات من السيرفر مباشرة (بدون كاش) */
async function fetchRecords() {
  const snap = await col().orderBy("createdAt", "desc").get({ source: "server" });
  return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
}

const saveRecord = (rec) => col().doc(rec.id).set(rec);
const removeRecord = (id) => col().doc(id).delete();

/** حفظ مجموعة سجلات على دفعات (حد Firestore 500 عملية للدفعة) */
async function saveMany(list) {
  for (let i = 0; i < list.length; i += 400) {
    const batch = db.batch();
    list.slice(i, i + 400).forEach((r) => batch.set(col().doc(r.id), r));
    await batch.commit();
  }
}

function showLoading(text) { $("loadingText").textContent = text; $("loading").hidden = false; }
function hideLoading() { $("loading").hidden = true; }

/* ========== أدوات ========== */
const $ = (id) => document.getElementById(id);

function uid() {
  return (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function formatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "-";
  return d.toLocaleDateString("ar-EG-u-nu-latn", { year: "numeric", month: "2-digit", day: "2-digit" });
}

const fmt = (n) => Number(n).toLocaleString("en-US");

/** التحقق من المدخلات؛ يعيد {name, years} أو {errors} */
function validate(nameRaw, yearsRaw) {
  const errors = {};
  const name = String(nameRaw ?? "").trim().replace(/\s+/g, " ");
  const yStr = String(yearsRaw ?? "").trim();
  if (!name) errors.name = "الاسم مطلوب";
  else if (name.length > 100) errors.name = "الاسم طويل جدًا";
  if (!yStr) errors.years = "عدد السنوات مطلوب";
  else if (!/^-?\d+$/.test(yStr)) errors.years = "يجب إدخال رقم صحيح";
  else if (Number(yStr) <= 0) errors.years = "يجب أن يكون عدد السنوات أكبر من 0";
  else if (Number(yStr) > MAX_YEARS) errors.years = "عدد السنوات كبير جدًا";
  return Object.keys(errors).length ? { errors } : { name, years: Number(yStr) };
}

function showErrors(errors, map) {
  for (const key of Object.keys(map)) {
    const [input, msg] = map[key].map($);
    msg.textContent = errors[key] || "";
    input.classList.toggle("invalid", !!errors[key]);
  }
}

function toast(text, type = "ok") {
  const el = document.createElement("div");
  el.className = "toast" + (type === "ok" ? "" : " " + type);
  el.textContent = text;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

/* ========== العرض ========== */
function buildBreakdownTable(years) {
  const table = document.createElement("table");
  const thead = table.createTHead().insertRow();
  ["السنة", "قيمة الاشتراك", "الغرامة", "إجمالي السنة"].forEach((t) => {
    const th = document.createElement("th"); th.textContent = t; thead.appendChild(th);
  });
  const tbody = table.createTBody();
  getBreakdown(years).forEach((r) => {
    const tr = tbody.insertRow();
    [r.year, r.fee, Math.round(r.rate * 100) + "%", fmt(r.total)].forEach((v) => {
      tr.insertCell().textContent = v;
    });
  });
  const tr = table.createTFoot().insertRow();
  const c = tr.insertCell(); c.colSpan = 3; c.textContent = "إجمالي المبلغ المستحق:";
  tr.insertCell().textContent = fmt(calculateFine(years));
  return table;
}

function renderStats() {
  $("statMembers").textContent = fmt(records.length);
  $("statYears").textContent = fmt(records.reduce((s, r) => s + r.years, 0));
  $("statAmount").textContent = fmt(records.reduce((s, r) => s + r.amount, 0));
  $("statRecords").textContent = fmt(records.length);
}

function renderTable() {
  const term = searchTerm.trim().toLowerCase();
  const list = records.filter((r) => r.name.toLowerCase().includes(term));
  const body = $("tableBody");
  body.textContent = "";

  const empty = list.length === 0;
  $("tableWrap").hidden = empty;
  $("emptyState").hidden = !empty;
  if (empty) {
    const noData = records.length === 0;
    $("emptyText").textContent = noData ? "لا توجد عضويات مسجلة حاليًا" : "لا توجد نتائج مطابقة للبحث";
    $("emptyAddBtn").hidden = !noData;
  }

  const frag = document.createDocumentFragment();
  list.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.dataset.id = r.id;
    [i + 1, r.name, r.years, fmt(r.amount), formatDate(r.createdAt)].forEach((v, idx) => {
      const td = document.createElement("td");
      td.textContent = v;
      if (idx !== 1) td.className = "num";
      tr.appendChild(td);
    });
    const td = document.createElement("td");
    const box = document.createElement("div");
    box.className = "row-actions";
    [["details", "التفاصيل", "btn-outline"], ["edit", "تعديل", "btn-outline"], ["delete", "حذف", "btn-danger"]]
      .forEach(([action, label, cls]) => {
        const b = document.createElement("button");
        b.type = "button"; b.className = "btn btn-sm " + cls;
        b.dataset.action = action; b.textContent = label;
        b.setAttribute("aria-label", label + " " + r.name);
        box.appendChild(b);
      });
    td.appendChild(box); tr.appendChild(td); frag.appendChild(tr);
  });
  body.appendChild(frag);
}

function render() { renderStats(); renderTable(); }

/* ========== إضافة ========== */
const addMap = { name: ["nameInput", "nameError"], years: ["yearsInput", "yearsError"] };

function handleCalc() {
  const v = validate($("nameInput").value, $("yearsInput").value);
  showErrors(v.errors || {}, addMap);
  if (v.errors) { $("result").hidden = true; return null; }
  $("resultAmount").textContent = fmt(calculateFine(v.years));
  const bd = $("resultBreakdown");
  bd.textContent = ""; bd.appendChild(buildBreakdownTable(v.years));
  $("result").hidden = false;
  return v;
}

async function handleAdd(e) {
  e.preventDefault();
  const v = handleCalc();
  if (!v) return;
  const rec = { id: uid(), name: v.name, years: v.years, amount: calculateFine(v.years), createdAt: new Date().toISOString() };
  showLoading("جاري الحفظ...");
  try {
    await saveRecord(rec);
    records.unshift(rec);
    $("addForm").reset();
    $("result").hidden = true;
    render();
    toast("تمت إضافة العضوية بنجاح");
  } catch (err) {
    console.error(err);
    toast("تعذّر الحفظ على السيرفر", "error");
  } finally { hideLoading(); }
}

/* ========== تعديل / حذف / تفاصيل ========== */
const editMap = { name: ["editName", "editNameError"], years: ["editYears", "editYearsError"] };

function openEdit(rec) {
  editingId = rec.id;
  $("editName").value = rec.name;
  $("editYears").value = rec.years;
  showErrors({}, editMap);
  updateEditPreview();
  $("editModal").showModal();
}

function updateEditPreview() {
  const v = validate($("editName").value || "x", $("editYears").value);
  $("editAmount").textContent = v.errors && v.errors.years ? "-" : fmt(calculateFine(v.years));
}

async function handleEditSubmit(e) {
  e.preventDefault();
  const v = validate($("editName").value, $("editYears").value);
  showErrors(v.errors || {}, editMap);
  if (v.errors) return;
  const rec = records.find((r) => r.id === editingId);
  if (!rec) return $("editModal").close();
  const updated = { ...rec, name: v.name, years: v.years, amount: calculateFine(v.years) };
  showLoading("جاري الحفظ...");
  try {
    await saveRecord(updated);
    Object.assign(rec, updated);
    $("editModal").close();
    render();
    toast("تم تحديث البيانات بنجاح");
  } catch (err) {
    console.error(err);
    toast("تعذّر تحديث البيانات على السيرفر", "error");
  } finally { hideLoading(); }
}

async function handleConfirmDelete() {
  showLoading("جاري الحذف...");
  try {
    await removeRecord(deletingId);
    records = records.filter((r) => r.id !== deletingId);
    $("deleteModal").close();
    render();
    toast("تم حذف السجل بنجاح");
  } catch (err) {
    console.error(err);
    toast("تعذّر حذف السجل من السيرفر", "error");
  } finally { hideLoading(); }
}

function handleTableClick(e) {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const id = btn.closest("tr").dataset.id;
  const rec = records.find((r) => r.id === id);
  if (!rec) return;
  if (btn.dataset.action === "edit") openEdit(rec);
  else if (btn.dataset.action === "delete") { deletingId = id; $("deleteModal").showModal(); }
  else {
    $("detailsTitle").textContent = "تفاصيل الحساب - " + rec.name + " (" + rec.years + " سنة)";
    const body = $("detailsBody");
    body.textContent = ""; body.appendChild(buildBreakdownTable(rec.years));
    $("detailsModal").showModal();
  }
}

/* ========== Excel ========== */
function xlsxReady() {
  if (typeof XLSX === "undefined") {
    toast("مكتبة Excel غير متوفرة. تحقق من الاتصال بالإنترنت", "error");
    return false;
  }
  return true;
}

function handleExport() {
  if (!xlsxReady()) return;
  if (!records.length) return toast("لا توجد بيانات للتصدير", "warn");
  try {
    const rows = [["الاسم", "عدد السنين", "المبلغ المطلوب", "تاريخ الإضافة"]]
      .concat(records.map((r) => [r.name, r.years, r.amount, formatDate(r.createdAt)]));
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 28 }, { wch: 12 }, { wch: 16 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "السجل");
    wb.Workbook = { Views: [{ RTL: true }] };
    XLSX.writeFile(wb, "سجل_العضويات.xlsx");
    toast("تم تصدير الملف بنجاح");
  } catch (e) {
    toast("حدث خطأ أثناء التصدير", "error");
  }
}

function handleFileChosen(e) {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !xlsxReady()) return;
  showLoading("جاري معالجة الملف...");
  const reader = new FileReader();
  reader.onerror = () => { hideLoading(); toast("حدث خطأ أثناء قراءة الملف", "error"); };
  reader.onload = () => setTimeout(async () => {
    try { await importWorkbook(reader.result); }
    catch (err) { console.error(err); toast("حدث خطأ أثناء قراءة الملف", "error"); }
    finally { hideLoading(); }
  }, 50);
  reader.readAsArrayBuffer(file);
}

async function importWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error("empty");
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true });
  if (!rows.length) throw new Error("empty");

  // تحديد الأعمدة من الترويسة، وإلا نفترض العمود الأول = الاسم والثاني = السنوات
  const header = rows[0].map((c) => String(c).trim());
  let nameCol = header.findIndex((h) => h === "الاسم");
  let yearsCol = header.findIndex((h) => h === "عدد السنين" || h === "عدد السنوات");
  let start = 1;
  if (nameCol === -1 || yearsCol === -1) { nameCol = 0; yearsCol = 1; start = 0; }

  let ok = 0, bad = 0;
  const added = [];
  for (let i = start; i < rows.length; i++) {
    const row = rows[i];
    if (row.every((c) => String(c).trim() === "")) continue; // تجاهل الصفوف الفارغة تمامًا
    const v = validate(row[nameCol], row[yearsCol]);
    if (v.errors) { bad++; continue; }
    // المبلغ في Excel يُتجاهل ويُحسب من calculateFine
    added.push({ id: uid(), name: v.name, years: v.years, amount: calculateFine(v.years), createdAt: new Date().toISOString() });
    ok++;
  }
  if (ok) {
    showLoading("جاري رفع البيانات إلى السيرفر...");
    try { await saveMany(added); }
    catch (err) { console.error(err); return toast("تعذّر حفظ السجلات المستوردة على السيرفر", "error"); }
    records = added.concat(records);
    render();
  }
  if (ok) toast("تم استيراد " + ok + " سجلًا بنجاح" + (bad ? " (" + bad + " صفوف بها أخطاء)" : ""), bad ? "warn" : "ok");
  else toast(bad ? "لم يتم استيراد أي سجل، " + bad + " صفوف بها أخطاء" : "الملف لا يحتوي على بيانات", "error");
}

/* ========== الأحداث ========== */
function init() {
  $("calcBtn").addEventListener("click", handleCalc);
  $("addForm").addEventListener("submit", handleAdd);
  $("searchInput").addEventListener("input", (e) => { searchTerm = e.target.value; renderTable(); });
  $("tableBody").addEventListener("click", handleTableClick);
  $("editForm").addEventListener("submit", handleEditSubmit);
  $("editYears").addEventListener("input", updateEditPreview);
  $("confirmDelete").addEventListener("click", handleConfirmDelete);
  $("exportBtn").addEventListener("click", handleExport);
  $("importBtn").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", handleFileChosen);
  $("emptyAddBtn").addEventListener("click", () => { $("addSection").scrollIntoView({ behavior: "smooth" }); $("nameInput").focus(); });
  document.querySelectorAll("dialog").forEach((d) => {
    d.addEventListener("click", (e) => { if (e.target === d || e.target.closest("[data-close]")) d.close(); });
  });
  $("retryBtn").addEventListener("click", loadFromServer);
  loadFromServer();
}

/** تحميل كل البيانات من السيرفر قبل إظهار الصفحة */
async function loadFromServer() {
  showLoading("جاري تحميل البيانات من السيرفر...");
  $("loadError").hidden = true;
  try {
    records = await fetchRecords();
    render();
    $("app").hidden = false;
  } catch (err) {
    console.error(err);
    $("loadError").hidden = false;
  } finally { hideLoading(); }
}

document.addEventListener("DOMContentLoaded", init);
