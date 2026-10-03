"use strict";

/* ========== إعدادات الحساب (عدّلها هنا مستقبلًا) ========== */
const BASE_FEE = 10;                      // قيمة الاشتراك الأساسية لكل سنة
const PENALTY_RATES = [0, 0.5, 1, 2, 3];  // نسبة الغرامة للسنوات 1..5 (السنة 5 وما بعدها تأخذ آخر نسبة)
const STAMP_VALUE = 15;                   // الطوابع: تُضاف مرة واحدة لكل عملية
const COLLECTION = "membership_fines";
const MAX_YEARS = 1000;
const MAX_NAME = 100;
const MAX_FILE_BYTES = 5 * 1024 * 1024;   // أقصى حجم لملف Excel
const MAX_ROWS = 2000;                    // أقصى عدد صفوف في الاستيراد
const BATCH_SIZE = 400;                   // حد Firestore: 500 عملية لكل batch
const RECEIPT_RE = /^[\p{L}\p{N}][\p{L}\p{N}\-_/. ]*$/u;   // حروف/أرقام/ - _ / . ومسافات داخلية

/*
 * ملاحظة أمنية: الحسابات هنا (calculateFine/STAMP_VALUE) مجرد راحة للمستخدم.
 * الحماية الحقيقية للمبالغ في firestore.rules الذي يعيد حساب amount/stamp/totalAmount
 * ويرفض أي كتابة لا تطابقها. عند تغيير الأسعار عدّل الاثنين معًا.
 */

function getPenaltyRate(yearNumber) {
  return PENALTY_RATES[Math.min(yearNumber, PENALTY_RATES.length) - 1];
}

function getBreakdown(years) {
  const rows = [];
  for (let y = 1; y <= years; y++) {
    const rate = getPenaltyRate(y);
    rows.push({ year: y, fee: BASE_FEE, rate, total: BASE_FEE * (1 + rate) });
  }
  return rows;
}

/** إجمالي الاشتراكات والغرامات فقط (بدون الطوابع) */
function calculateFine(years) {
  let total = 0;
  for (let y = 1; y <= years; y++) total += BASE_FEE * (1 + getPenaltyRate(y));
  return total;
}

/** الإجمالي النهائي = الاشتراكات والغرامات + الطوابع (مرة واحدة) */
function calculateTotal(years) {
  return calculateFine(years) + STAMP_VALUE;
}

/* ========== الحالة ========== */
let records = [];
let searchTerm = "";
let statusFilter = "all";
let editingId = null, deletingId = null, unpayingId = null;
let busy = false;
let authSeq = 0;          // لتجاهل نتائج غير محدّثة عند تغيّر حالة الدخول بسرعة
let unsubscribe = null;

const $ = (id) => document.getElementById(id);
const col = () => db.collection(COLLECTION);
const TS = () => firebase.firestore.FieldValue.serverTimestamp();
const fmt = (n) => Number(n).toLocaleString("en-US");

/* ========== أدوات ========== */
function formatDate(ms) {
  if (!ms) return "-";
  return new Date(ms).toLocaleDateString("ar-EG-u-nu-latn", { year: "numeric", month: "2-digit", day: "2-digit" });
}

function toast(text, type = "ok") {
  const el = document.createElement("div");
  el.className = "toast" + (type === "ok" ? "" : " " + type);
  el.textContent = text;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function showLoading(text) { $("loadingText").textContent = text; $("loading").hidden = false; }
function hideLoading() { $("loading").hidden = true; }

function showView(name) {
  ["splash", "loginView", "errorView", "app"].forEach((v) => { $(v).hidden = v !== name; });
}

/** تحويل أخطاء Firebase إلى رسائل عربية قصيرة */
function errMsg(err, fallback) {
  const c = (err && err.code) || "";
  if (c === "permission-denied") return "تم رفض العملية من قاعدة البيانات، تأكد من صحة البيانات وأعد المحاولة.";
  if (c === "unavailable" || c === "timeout" || c === "auth/network-request-failed") return "تعذر الاتصال بقاعدة البيانات.";
  if (c === "parse") return "حدث خطأ أثناء قراءة الملف";
  if (c === "toomany") return "عدد الصفوف كبير جدًا (الحد الأقصى " + MAX_ROWS + " صف).";
  return fallback;
}

function authErrMsg(err, fallback) {
  const c = (err && err.code) || "";
  if (["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found", "auth/invalid-login-credentials"].includes(c))
    return "البريد الإلكتروني أو كلمة المرور غير صحيحة.";
  if (c === "auth/invalid-email") return "البريد الإلكتروني غير صالح.";
  if (c === "auth/user-disabled") return "هذا الحساب موقوف.";
  if (c === "auth/too-many-requests") return "محاولات كثيرة، حاول مرة أخرى بعد قليل.";
  if (c === "auth/network-request-failed") return "تعذر الاتصال بالإنترنت.";
  return fallback;
}

function withTimeout(promise, ms) {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej({ code: "timeout" }), ms); });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

/** تشغيل عملية مع شاشة تحميل ومنع الضغط المتكرر؛ تعيد true عند النجاح */
async function runOp(text, fn, fallback, timeout = 20000) {
  if (busy) return false;
  if (!auth.currentUser) { toast("انتهت الجلسة، يرجى تسجيل الدخول من جديد.", "error"); return false; }
  busy = true; showLoading(text);
  try { await withTimeout(Promise.resolve().then(fn), timeout); return true; }
  catch (err) { console.error(err); toast(errMsg(err, fallback), "error"); return false; }
  finally { busy = false; hideLoading(); }
}

function validate(nameRaw, yearsRaw) {
  const errors = {};
  const name = String(nameRaw ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").trim().replace(/\s+/g, " ");
  const yStr = String(yearsRaw ?? "").trim();
  if (!name) errors.name = "الاسم مطلوب";
  else if (name.length > MAX_NAME) errors.name = "الاسم طويل جدًا";
  if (!yStr) errors.years = "عدد السنوات مطلوب";
  else if (!/^-?\d+$/.test(yStr)) errors.years = "يجب إدخال رقم صحيح";
  else if (Number(yStr) <= 0) errors.years = "يجب أن يكون عدد السنوات أكبر من 0";
  else if (Number(yStr) > MAX_YEARS) errors.years = "عدد السنوات كبير جدًا";
  return Object.keys(errors).length ? { errors } : { name, years: Number(yStr) };
}

/** التحقق من رقم الإيصال؛ يعيد {value} نصًا (للحفاظ على الأصفار) أو {error} */
function validateReceipt(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return { error: "يرجى إدخال رقم الإيصال" };
  if (value.length > 50) return { error: "رقم الإيصال طويل جدًا" };
  if (!RECEIPT_RE.test(value)) return { error: "رقم الإيصال يقبل الحروف والأرقام والرموز - _ / . فقط" };
  return { value };
}

function showErrors(errors, map) {
  for (const key of Object.keys(map)) {
    const [input, msg] = map[key].map($);
    msg.textContent = errors[key] || "";
    input.classList.toggle("invalid", !!errors[key]);
  }
}

/** بناء مستند عضوية جديد؛ إذا مُرّر receipt يُسجَّل كمدفوع (يُستخدم في الاستيراد فقط) */
function buildDoc(name, years, receipt = null) {
  const amount = calculateFine(years);
  return {
    name, years, amount, stamp: STAMP_VALUE, totalAmount: amount + STAMP_VALUE,
    paymentStatus: receipt ? "paid" : "unpaid",
    receiptNumber: receipt || null,
    paidAt: receipt ? TS() : null,
    createdAt: TS(), updatedAt: TS()
  };
}

/* ========== Firestore (Real-time) ========== */
function toMs(v) {
  if (!v) return 0;
  if (typeof v.toMillis === "function") return v.toMillis();
  const t = Date.parse(v);
  return isNaN(t) ? 0 : t;
}

/** تحويل المستند إلى سجل جاهز للعرض (مع دعم السجلات القديمة التي لا تحتوي الحقول الجديدة) */
function normalize(d) {
  const x = d.data({ serverTimestamps: "estimate" });
  const years = Number(x.years) || 0;
  const amount = Number.isFinite(x.amount) ? x.amount : calculateFine(years);
  const stamp = Number.isFinite(x.stamp) ? x.stamp : STAMP_VALUE;
  return {
    id: d.id, name: String(x.name ?? ""), years, amount, stamp,
    totalAmount: Number.isFinite(x.totalAmount) ? x.totalAmount : amount + stamp,
    paymentStatus: x.paymentStatus === "paid" ? "paid" : "unpaid",
    receiptNumber: x.receiptNumber == null || String(x.receiptNumber).trim() === "" ? null : String(x.receiptNumber),
    createdMs: toMs(x.createdAt), paidMs: toMs(x.paidAt)
  };
}

/** الاشتراك في التغييرات؛ تتحقق الـ Promise عند وصول أول نسخة من السيرفر */
function startListening() {
  return new Promise((resolve, reject) => {
    let first = true;
    unsubscribe = col().onSnapshot((snap) => {
      records = snap.docs.map(normalize).sort((a, b) => b.createdMs - a.createdMs);
      render();
      if (first) { first = false; resolve(); }
    }, (err) => {
      console.error(err);
      if (first) { first = false; reject(err); }
      else toast(errMsg(err, "تعذر الاتصال بقاعدة البيانات."), "error");
    });
  });
}

function stopListening() { if (unsubscribe) { unsubscribe(); unsubscribe = null; } }

async function saveMany(list) {
  for (let i = 0; i < list.length; i += BATCH_SIZE) {
    const batch = db.batch();
    list.slice(i, i + BATCH_SIZE).forEach((doc) => batch.set(col().doc(), doc));
    await batch.commit();
  }
}

/* ========== المصادقة (Email Link) ========== */
function setNotice(text, type) {
  const el = $("loginNotice");
  el.hidden = !text;
  el.textContent = text || "";
  el.className = "notice" + (type ? " " + type : "");
}


async function handleLogin(e) {
  e.preventDefault();
  const btn = $("loginBtn");
  if (btn.disabled) return;
  const email = $("emailInput").value.trim();
  const password = $("passwordInput").value;
  const errors = {};
  if (!email) errors.email = "البريد الإلكتروني مطلوب";
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = "البريد الإلكتروني غير صالح";
  if (!password) errors.password = "كلمة المرور مطلوبة";
  $("emailError").textContent = errors.email || "";
  $("passwordError").textContent = errors.password || "";
  if (Object.keys(errors).length) return;
  setNotice("");
  btn.disabled = true;
  btn.textContent = "جاري تسجيل الدخول...";
  try {
    await auth.signInWithEmailAndPassword(email, password);   // onAuthStateChanged يكمل الباقي
  } catch (ex) {
    console.error(ex);
    setNotice(authErrMsg(ex, "تعذر تسجيل الدخول، حاول مرة أخرى."), "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "تسجيل الدخول";
  }
}

/** تفريغ كل بيانات الجلسة من الذاكرة والـ DOM عند الخروج */
function resetSession() {
  document.querySelectorAll("dialog[open]").forEach((d) => d.close());
  $("addForm").reset();
  $("result").hidden = true;
  $("searchInput").value = ""; searchTerm = "";
  $("statusFilter").value = "all"; statusFilter = "all";
  $("userEmail").textContent = "";
  render();
}

async function handleAuthState(user) {
  const seq = ++authSeq;
  stopListening();
  if (!user) {
    records = [];
    $("passwordInput").value = "";
    resetSession();
    showView("loginView");
    return;
  }
  // مسجل الدخول عبر Firebase Authentication = يدخل مباشرة؛ لا يوجد أي فحص صلاحيات إضافي
  showView("splash");                       // تبقى ظاهرة حتى تصل البيانات
  $("userEmail").textContent = user.email || "";
  try {
    await startListening();
    if (seq !== authSeq) return;
    showView("app");
  } catch (err) {
    if (seq !== authSeq) return;
    console.error(err);
    stopListening();
    $("errorText").textContent = err && err.code === "permission-denied"
      ? "تعذر الوصول إلى البيانات. تأكد من نشر قواعد Firestore ثم أعد المحاولة."
      : "تعذر الاتصال بقاعدة البيانات.";
    showView("errorView");
  }
}

async function handleLogout() {
  try { await auth.signOut(); }
  catch (err) { console.error(err); toast("تعذر تسجيل الخروج، حاول مرة أخرى.", "error"); }
}

/* ========== العرض ========== */
function buildBreakdownTable(years) {
  const table = document.createElement("table");
  table.className = "details-table";
  const head = table.createTHead().insertRow();
  ["السنة", "قيمة الاشتراك", "الغرامة", "إجمالي السنة"].forEach((t) => {
    const th = document.createElement("th"); th.textContent = t; head.appendChild(th);
  });
  const tbody = table.createTBody();
  getBreakdown(years).forEach((r) => {
    const tr = tbody.insertRow();
    [r.year, r.fee, Math.round(r.rate * 100) + "%", fmt(r.total)].forEach((v) => { tr.insertCell().textContent = v; });
  });
  const tfoot = table.createTFoot();
  [["قيمة الاشتراكات والغرامات", calculateFine(years)],
   ["الطوابع (تُضاف مرة واحدة فقط)", STAMP_VALUE],
   ["الإجمالي المطلوب", calculateTotal(years)]].forEach(([label, value]) => {
    const tr = tfoot.insertRow();
    const c = tr.insertCell(); c.colSpan = 3; c.textContent = label;
    tr.insertCell().textContent = fmt(value);
  });
  return table;
}

function filteredRecords() {
  const term = searchTerm.trim().toLowerCase();
  return records.filter((r) => {
    // رقم الإيصال يُعامل كنص دائمًا للحفاظ على الأصفار في بدايته (00125)
    const name = String(r.name || "").toLowerCase();
    const receipt = String(r.receiptNumber || "").toLowerCase();
    const matchesSearch = !term || name.includes(term) || receipt.includes(term);
    return matchesSearch && (statusFilter === "all" || r.paymentStatus === statusFilter);
  });
}

function renderStats(visibleCount) {
  const paid = records.filter((r) => r.paymentStatus === "paid");
  const unpaid = records.filter((r) => r.paymentStatus !== "paid");
  const sum = (list) => list.reduce((s, r) => s + r.totalAmount, 0);
  $("statMembers").textContent = fmt(records.length);
  $("statYears").textContent = fmt(unpaid.reduce((s, r) => s + r.years, 0));
  $("statAmount").textContent = fmt(sum(records));
  $("statRecords").textContent = fmt(visibleCount);
  $("statPaidAmount").textContent = fmt(sum(paid));
  $("statUnpaidAmount").textContent = fmt(sum(unpaid));
  $("statPaidCount").textContent = fmt(paid.length);
  $("statUnpaidCount").textContent = fmt(unpaid.length);
}

function makeBtn(action, label, cls, name) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "btn btn-sm " + cls;
  b.dataset.action = action; b.textContent = label;
  b.setAttribute("aria-label", label + " " + name);
  return b;
}

function renderTable(list) {
  const body = $("tableBody");
  body.textContent = "";
  const empty = list.length === 0;
  $("tableWrap").hidden = empty;
  $("emptyState").hidden = !empty;
  if (empty) {
    const noData = records.length === 0;
    $("emptyText").textContent = noData ? "لا توجد عضويات مسجلة حاليًا" : "لا توجد نتائج مطابقة";
    $("emptyAddBtn").hidden = !noData;
  }

  const frag = document.createDocumentFragment();
  list.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.dataset.id = r.id;
    const cell = (v, cls) => { const td = document.createElement("td"); td.textContent = v; if (cls) td.className = cls; tr.appendChild(td); return td; };
    cell(i + 1, "num"); cell(r.name); cell(r.years, "num"); cell(fmt(r.totalAmount), "num");

    const st = document.createElement("td");
    const badge = document.createElement("span");
    const paid = r.paymentStatus === "paid";
    badge.className = "badge " + (paid ? "badge-paid" : "badge-unpaid");
    badge.textContent = paid ? "تم الدفع" : "غير مدفوع";
    st.appendChild(badge);
    if (paid && r.paidMs) {
      const note = document.createElement("small");
      note.className = "status-note";
      note.textContent = "تم الدفع في: " + formatDate(r.paidMs);
      st.appendChild(note);
    }
    tr.appendChild(st);

    const rc = document.createElement("td");
    if (paid) {
      const sp = document.createElement("span");
      sp.dir = "ltr"; sp.textContent = r.receiptNumber || "—";
      rc.appendChild(sp);
      rc.appendChild(makeBtn("editReceipt", "تعديل رقم الإيصال", "btn-outline", r.name));
    } else rc.textContent = "—";
    tr.appendChild(rc);

    cell(formatDate(r.createdMs), "num");

    const td = document.createElement("td");
    const box = document.createElement("div");
    box.className = "row-actions";
    box.appendChild(paid ? makeBtn("unpay", "إلغاء الدفع", "btn-outline", r.name) : makeBtn("pay", "تم الدفع", "btn-success", r.name));
    box.appendChild(makeBtn("details", "التفاصيل", "btn-outline", r.name));
    box.appendChild(makeBtn("edit", "تعديل", "btn-outline", r.name));
    box.appendChild(makeBtn("delete", "حذف", "btn-danger", r.name));
    td.appendChild(box); tr.appendChild(td);
    frag.appendChild(tr);
  });
  body.appendChild(frag);
}

function render() {
  const list = filteredRecords();
  renderStats(list.length);
  renderTable(list);
}

/* ========== إضافة ========== */
const addMap = { name: ["nameInput", "nameError"], years: ["yearsInput", "yearsError"] };

function handleCalc() {
  const v = validate($("nameInput").value, $("yearsInput").value);
  showErrors(v.errors || {}, addMap);
  if (v.errors) { $("result").hidden = true; return null; }
  $("resultAmount").textContent = fmt(calculateTotal(v.years));
  $("resultSummary").textContent = "الاشتراكات والغرامات: " + fmt(calculateFine(v.years)) + " + الطوابع: " + fmt(STAMP_VALUE);
  const bd = $("resultBreakdown");
  bd.textContent = ""; bd.appendChild(buildBreakdownTable(v.years));
  $("result").hidden = false;
  return v;
}

async function handleAdd(e) {
  e.preventDefault();
  const v = handleCalc();
  if (!v) return;
  const ok = await runOp("جاري الحفظ...", () => col().add(buildDoc(v.name, v.years)), "تعذر حفظ البيانات، حاول مرة أخرى.");
  if (ok) {
    $("addForm").reset();
    $("result").hidden = true;
    toast("تمت إضافة العضوية بنجاح");
  }
}

/* ========== تعديل / حذف / دفع / تفاصيل ========== */
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
  $("editAmount").textContent = v.errors && v.errors.years ? "-" : fmt(calculateTotal(v.years));
}

async function handleEditSubmit(e) {
  e.preventDefault();
  const v = validate($("editName").value, $("editYears").value);
  showErrors(v.errors || {}, editMap);
  if (v.errors) return;
  const id = editingId;
  const amount = calculateFine(v.years);
  const ok = await runOp("جاري تحديث البيانات...", () => col().doc(id).update({
    name: v.name, years: v.years, amount, stamp: STAMP_VALUE, totalAmount: amount + STAMP_VALUE, updatedAt: TS()
  }), "تعذر تحديث البيانات، حاول مرة أخرى.");
  if (ok) { $("editModal").close(); toast("تم تحديث البيانات بنجاح"); }
}

async function handleConfirmDelete() {
  const id = deletingId;
  const ok = await runOp("جاري الحذف...", () => col().doc(id).delete(), "تعذر حذف السجل، حاول مرة أخرى.");
  if (ok) { $("deleteModal").close(); toast("تم حذف السجل بنجاح"); }
}

/** إلغاء الدفع: يعيد الحالة إلى غير مدفوع ويحذف رقم الإيصال وتاريخ الدفع */
async function cancelPayment(id) {
  return runOp("جاري تحديث حالة الدفع...", () => col().doc(id).update({
    paymentStatus: "unpaid", receiptNumber: null, paidAt: null, updatedAt: TS()
  }), "تعذر تحديث حالة الدفع.");
}

async function handleConfirmUnpay() {
  if (await cancelPayment(unpayingId)) { $("unpayModal").close(); toast("تمت إعادة العضوية إلى غير مدفوع"); }
}

/* ----- نافذة رقم الإيصال (تسجيل الدفع / تعديل الرقم) ----- */
let receiptMode = null, receiptId = null;

function openReceipt(mode, rec) {
  receiptMode = mode; receiptId = rec.id;
  $("receiptTitle").textContent = mode === "pay" ? "تسجيل عملية الدفع" : "تعديل رقم الإيصال";
  $("receiptSubmit").textContent = mode === "pay" ? "حفظ" : "حفظ التعديل";
  $("receiptMember").textContent = rec.name + " — الإجمالي: " + fmt(rec.totalAmount);
  $("receiptInput").value = mode === "edit" ? (rec.receiptNumber || "") : "";
  $("receiptError").textContent = "";
  $("receiptInput").classList.remove("invalid");
  $("receiptModal").showModal();
  $("receiptInput").focus();
}

async function handleReceiptSubmit(e) {
  e.preventDefault();
  if (busy) return;
  const rv = validateReceipt($("receiptInput").value);
  const value = rv.value;
  const error = rv.error || "";
  $("receiptError").textContent = error;
  $("receiptInput").classList.toggle("invalid", !!error);
  if (error) return;

  const id = receiptId, mode = receiptMode;
  const rec = records.find((r) => r.id === id);
  if (!rec) { $("receiptModal").close(); return; }
  if (mode === "pay" && rec.paymentStatus === "paid") { $("receiptModal").close(); return toast("هذه العضوية مسجلة كمدفوعة بالفعل", "warn"); }
  if (mode === "edit" && rec.paymentStatus !== "paid") { $("receiptModal").close(); return toast("هذه العضوية لم تعد مدفوعة", "warn"); }

  const data = mode === "pay"
    ? { paymentStatus: "paid", receiptNumber: value, paidAt: TS(), updatedAt: TS() }
    : { receiptNumber: value, updatedAt: TS() };            // التعديل لا يغير الحالة ولا تاريخ الدفع

  const btn = $("receiptSubmit"), label = btn.textContent;
  btn.disabled = true; btn.textContent = "جاري الحفظ...";
  const ok = await runOp(
    mode === "pay" ? "جاري تحديث حالة الدفع..." : "جاري تحديث البيانات...",
    () => col().doc(id).update(data),
    mode === "pay" ? "تعذر تحديث حالة الدفع." : "تعذر تعديل رقم الإيصال.");
  btn.disabled = false; btn.textContent = label;
  if (ok) {
    $("receiptModal").close();
    toast(mode === "pay" ? "تم تسجيل الدفع بنجاح" : "تم تعديل رقم الإيصال بنجاح");
  }
}

async function handleTableClick(e) {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const id = btn.closest("tr").dataset.id;
  const rec = records.find((r) => r.id === id);
  if (!rec) return;
  switch (btn.dataset.action) {
    case "edit": openEdit(rec); break;
    case "delete": deletingId = id; $("deleteModal").showModal(); break;
    case "unpay": unpayingId = id; $("unpayModal").showModal(); break;
    case "pay": openReceipt("pay", rec); break;               // فتح النافذة فقط بدون تحديث Firestore
    case "editReceipt": openReceipt("edit", rec); break;
    case "details": {
      $("detailsTitle").textContent = "تفاصيل الحساب - " + rec.name + " (" + rec.years + " سنة)";
      const body = $("detailsBody");
      body.textContent = ""; body.appendChild(buildBreakdownTable(rec.years));
      $("detailsModal").showModal();
    }
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
    const rows = [["الاسم", "عدد السنين", "الغرامات والاشتراكات", "الطوابع", "الإجمالي المطلوب", "حالة الدفع", "رقم الإيصال", "تاريخ الإضافة", "تاريخ الدفع"]]
      .concat(records.map((r) => [
        r.name, r.years, r.amount, r.stamp, r.totalAmount,
        r.paymentStatus === "paid" ? "تم الدفع" : "غير مدفوع",
        r.paymentStatus === "paid" && r.receiptNumber ? String(r.receiptNumber) : "",   // نص للحفاظ على الأصفار
        formatDate(r.createdMs), r.paymentStatus === "paid" && r.paidMs ? formatDate(r.paidMs) : ""
      ]));
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 28 }, { wch: 12 }, { wch: 20 }, { wch: 10 }, { wch: 16 }, { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "السجل");
    wb.Workbook = { Views: [{ RTL: true }] };
    XLSX.writeFile(wb, "سجل_العضويات.xlsx");
    toast("تم تصدير الملف بنجاح");
  } catch (e) {
    console.error(e);
    toast("حدث خطأ أثناء التصدير", "error");
  }
}

/** قراءة ملف Excel وإرجاع {docs, bad}؛ المبلغ في الملف يُتجاهل ويُحسب من عدد السنوات */
function parseWorkbook(buffer) {
  let rows;
  try {
    // cellFormula/cellHTML معطّلان، وsheetRows يحدّ من عدد الصفوف المقروءة
    const wb = XLSX.read(buffer, { type: "array", cellFormula: false, cellHTML: false, sheetRows: MAX_ROWS + 2 });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true });
  } catch (e) { throw { code: "parse" }; }
  if (!rows.length) throw { code: "parse" };
  if (rows.length > MAX_ROWS + 1) throw { code: "toomany" };

  const header = rows[0].map((c) => String(c).trim());
  let nameCol = header.findIndex((h) => h === "الاسم");
  let yearsCol = header.findIndex((h) => h === "عدد السنين" || h === "عدد السنوات");
  let start = 1;
  if (nameCol === -1 || yearsCol === -1) { nameCol = 0; yearsCol = 1; start = 0; }
  const statusCol = start ? header.findIndex((h) => h === "حالة الدفع") : -1;
  const receiptCol = start ? header.findIndex((h) => h === "رقم الإيصال") : -1;

  const docs = []; let bad = 0, noReceipt = 0;
  for (let i = start; i < rows.length; i++) {
    const row = rows[i];
    if (row.every((c) => String(c).trim() === "")) continue;
    const v = validate(row[nameCol], row[yearsCol]);
    if (v.errors) { bad++; continue; }
    // الحالة "مدفوع" تُقبل فقط مع رقم إيصال صالح؛ غير ذلك تُستورد كغير مدفوع
    const rc = receiptCol >= 0 ? validateReceipt(row[receiptCol]) : { error: "none" };
    const isPaid = statusCol >= 0 && ["تم الدفع", "paid"].includes(String(row[statusCol]).trim());
    if (isPaid && !rc.value) noReceipt++;
    docs.push(buildDoc(v.name, v.years, isPaid && rc.value ? rc.value : null));
  }
  return { docs, bad, noReceipt };
}

async function handleFileChosen(e) {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !xlsxReady()) return;
  if (!/\.(xlsx|xls|csv)$/i.test(file.name)) return toast("نوع الملف غير مدعوم، اختر ملف Excel أو CSV.", "error");
  if (file.size > MAX_FILE_BYTES) return toast("حجم الملف كبير جدًا (الحد الأقصى 5 ميجابايت).", "error");
  await runOp("جاري استيراد البيانات...", async () => {
    await new Promise((r) => setTimeout(r, 30));           // السماح للشاشة بالظهور
    const { docs, bad, noReceipt } = parseWorkbook(await file.arrayBuffer());
    if (!docs.length) {
      toast(bad ? "لم يتم استيراد أي سجل، " + bad + " صفوف بها أخطاء" : "الملف لا يحتوي على بيانات", "error");
      return;
    }
    await saveMany(docs);
    toast("تم استيراد " + docs.length + " سجلًا بنجاح" + (bad ? " (" + bad + " صفوف بها أخطاء)" : "") +
      (noReceipt ? " — " + noReceipt + " صفوف مدفوعة بدون رقم إيصال صالح استُوردت كغير مدفوعة" : ""), bad || noReceipt ? "warn" : "ok");
  }, "تعذر حفظ البيانات، حاول مرة أخرى.", 180000);
}

/* ========== الأحداث والتشغيل ========== */
async function init() {
  $("loginForm").addEventListener("submit", handleLogin);
  $("logoutBtn").addEventListener("click", handleLogout);
  $("errorLogoutBtn").addEventListener("click", handleLogout);
  $("retryBtn").addEventListener("click", () => handleAuthState(auth.currentUser));
  $("calcBtn").addEventListener("click", handleCalc);
  $("addForm").addEventListener("submit", handleAdd);
  $("searchInput").addEventListener("input", (e) => { searchTerm = e.target.value; render(); });
  $("statusFilter").addEventListener("change", (e) => { statusFilter = e.target.value; render(); });
  $("tableBody").addEventListener("click", handleTableClick);
  $("editForm").addEventListener("submit", handleEditSubmit);
  $("editYears").addEventListener("input", updateEditPreview);
  $("confirmDelete").addEventListener("click", handleConfirmDelete);
  $("confirmUnpay").addEventListener("click", handleConfirmUnpay);
  $("receiptForm").addEventListener("submit", handleReceiptSubmit);
  $("exportBtn").addEventListener("click", handleExport);
  $("importBtn").addEventListener("click", () => $("fileInput").click());
  $("fileInput").addEventListener("change", handleFileChosen);
  $("emptyAddBtn").addEventListener("click", () => { $("addSection").scrollIntoView({ behavior: "smooth" }); $("nameInput").focus(); });
  document.querySelectorAll("dialog").forEach((d) => {
    d.addEventListener("click", (e) => { if (e.target === d || e.target.closest("[data-close]")) d.close(); });
  });

  auth.onAuthStateChanged(handleAuthState, (err) => {
    console.error(err);
    $("errorText").textContent = "تعذر الاتصال بقاعدة البيانات.";
    showView("errorView");
  });
}

document.addEventListener("DOMContentLoaded", init);
