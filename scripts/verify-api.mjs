// Verifies the bug fixes against a running backend seeded with `npm run seed`.
// Usage: node scripts/verify-api.mjs [baseUrl]   (default http://localhost:5000/api)
// Expects ADMIN_REGISTRATION_KEY=local_admin_key for the admin-key checks.
const BASE = process.argv[2] || "http://localhost:5000/api";
const results = [];
const arr = (x) => (Array.isArray(x) ? x : []);

async function call(method, path, { body, token, raw } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = raw ? token : `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data;
  const text = await res.text();
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
function check(id, title, pass, detail) {
  results.push({ id, title, pass, detail });
}

const login = (email, password) => call("POST", "/auth/login", { body: { email, password } });

// --- Auth ---
const adminLogin = await login("admin@coursemaster.com", "admin123");
check("BE-LOGIN", "Login with valid seeded admin credentials works", adminLogin.status === 200, `status=${adminLogin.status} msg=${adminLogin.data?.message ?? "ok"}`);
const studentLogin = await login("student@coursemaster.com", "student123");
const adminToken = adminLogin.data?.token;
const studentToken = studentLogin.data?.token;

// Login using the bcrypt hash as password must NOT work
const hashLogin = await call("POST", "/auth/login", { body: { email: "student@coursemaster.com", password: "$2b$10$abcdefghijklmnopqrstuv" } });
check("BE-HASHLOGIN", "Random string is rejected as password", hashLogin.status === 400, `status=${hashLogin.status}`);

// Privilege escalation through register payload
const uniq = Date.now();
const reg = await call("POST", "/auth/register", { body: { name: "Mallory", email: `mallory${uniq}@x.com`, password: "secret12", role: "admin" } });
check("BE-ROLE", "Register ignores client-supplied role=admin", reg.data?.user?.role !== "admin", `status=${reg.status} role=${reg.data?.user?.role}`);

// Admin registration with the correct key should create an admin; wrong key rejected
const regKey = await call("POST", "/auth/register", { body: { name: "Key Admin", email: `keyadmin${uniq}@x.com`, password: "secret12", adminKey: "local_admin_key" } });
check("BE-ADMINKEY", "Register with valid adminKey creates admin", regKey.data?.user?.role === "admin", `status=${regKey.status} role=${regKey.data?.user?.role}`);
const regBadKey = await call("POST", "/auth/register", { body: { name: "Bad Key", email: `badkey${uniq}@x.com`, password: "secret12", adminKey: "wrong" } });
check("BE-ADMINKEY2", "Register with invalid adminKey is rejected", regBadKey.status === 400, `status=${regBadKey.status} role=${regBadKey.data?.user?.role} msg=${regBadKey.data?.message}`);

// Validation error details
const badReg = await call("POST", "/auth/register", { body: { name: "A", email: "not-an-email", password: "1" } });
check("BE-VALIDATION", "Validation error returns field details", Array.isArray(badReg.data?.errors) && badReg.data.errors.length > 0, `status=${badReg.status} body=${JSON.stringify(badReg.data).slice(0, 160)}`);

// Invalid JWT must be rejected with 401
const badTok = await call("GET", "/auth/me", { token: "not.a.valid.jwt" });
check("BE-JWT", "Invalid JWT returns 401", badTok.status === 401, `status=${badTok.status} body=${JSON.stringify(badTok.data).slice(0, 120)}`);
const forged = await call("GET", "/enrollments/my", { token: "garbage" });
check("BE-JWT2", "Protected route with garbage token returns 401 (not 400/500)", forged.status === 401, `status=${forged.status} body=${JSON.stringify(forged.data).slice(0, 120)}`);

// --- CORS ---
const pre = await fetch(BASE + "/admin/courses/123", { method: "OPTIONS", headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "DELETE" } });
const allowM = pre.headers.get("access-control-allow-methods") || "";
check("BE-CORS", "CORS preflight allows PATCH/DELETE", /DELETE/.test(allowM) && /PATCH/.test(allowM), `allow-methods="${allowM}"`);

// --- Courses ---
const courses = await call("GET", "/courses?limit=20");
const course = courses.data?.courses?.[0];
const searchSpecial = await call("GET", "/courses?search=" + encodeURIComponent("C++ ("));
check("BE-SEARCH", "Search with regex special chars does not error", searchSpecial.status === 200, `status=${searchSpecial.status} msg=${searchSpecial.data?.message ?? ""}`);

const detail = await call("GET", `/courses/${course?._id}`);
const anyQuiz = JSON.stringify(detail.data).includes("correctIndex");
check("BE-ANSWERS", "Public course detail does not leak quiz correctIndex", !anyQuiz, `correctIndex present=${anyQuiz}`);
const detailAdmin = await call("GET", `/courses/${course?._id}`, { token: adminToken });
check("BE-ANSWERS-ADMIN", "Admin still receives correctIndex (needed by Edit Course)", JSON.stringify(detailAdmin.data).includes("correctIndex"), "");

const badId = await call("GET", "/courses/not-an-id");
check("BE-BADID", "Invalid course id returns 404 with friendly message", badId.status === 404 && !/Cast to ObjectId/i.test(badId.data?.message || ""), `status=${badId.status} msg=${badId.data?.message}`);

// --- Enrollment ---
const newStudent = await call("POST", "/auth/register", { body: { name: "New Student", email: `newstu${uniq}@x.com`, password: "secret12" } });
const nsToken = newStudent.data?.token;
const enroll = await call("POST", `/enrollments/${course?._id}`, { token: nsToken, body: {} });
check("BE-ENROLL", "New student can enroll in a course", enroll.status === 201, `status=${enroll.status} msg=${enroll.data?.message ?? ""}`);
const enroll2 = await call("POST", `/enrollments/${course?._id}`, { token: nsToken, body: {} });
check("BE-ENROLL-DUP", "Duplicate enrollment is rejected with clear message", enroll2.status === 400 && /already/i.test(enroll2.data?.message || ""), `status=${enroll2.status} msg=${enroll2.data?.message}`);

// --- Lesson completion persistence ---
const myEnr = await call("GET", "/enrollments/my", { token: nsToken });
const enrollment = arr(myEnr.data).find((e) => e.course?._id === course?._id);
const firstLesson = (detailAdmin.data?.syllabus ? detailAdmin.data : detail.data)?.syllabus?.[0]?.lessons?.[0];
const comp = await call("PATCH", `/enrollments/${enrollment?._id}/complete-lesson`, { token: nsToken, body: { lessonId: firstLesson?._id } });
const myEnrAfter = await call("GET", "/enrollments/my", { token: nsToken });
const persisted = arr(myEnrAfter.data).find((e) => e._id === enrollment?._id);
check("BE-COMPLETE", "Completed lesson is persisted", persisted?.progress?.completedLessons?.length === 1 && persisted?.progress?.percent > 0, `status=${comp.status} persisted=${JSON.stringify(persisted?.progress)}`);

// IDOR: another student completing someone else's enrollment
const idor = await call("PATCH", `/enrollments/${enrollment?._id}/complete-lesson`, { token: studentToken, body: { lessonId: (detailAdmin.data?.syllabus ? detailAdmin.data : detail.data)?.syllabus?.[0]?.lessons?.[1]?._id } });
check("BE-IDOR", "Student cannot modify another student's enrollment", idor.status === 403 || idor.status === 404, `status=${idor.status}`);

// Lesson that doesn't belong to course
const fakeLesson = await call("PATCH", `/enrollments/${enrollment?._id}/complete-lesson`, { token: nsToken, body: { lessonId: "64b000000000000000000000" } });
check("BE-FAKELESSON", "Completing a lesson id not in the course is rejected", fakeLesson.status === 400 || fakeLesson.status === 404, `status=${fakeLesson.status} percent=${fakeLesson.data?.progress?.percent}`);

// --- Quiz score ---
let quizLesson = null;
for (const m of (detailAdmin.data?.syllabus || detail.data?.syllabus || [])) for (const l of m.lessons || []) if (!quizLesson && l.quiz?.length) quizLesson = l;
const allCorrect = quizLesson?.quiz.map((q) => q.correctIndex);
const quiz = await call("POST", "/quizzes/submit", { token: nsToken, body: { courseId: course?._id, lessonId: quizLesson?._id, answers: allCorrect } });
check("BE-QUIZ", "All-correct quiz scores 100%", quiz.data?.percent === 100, `percent=${quiz.data?.percent} score=${quiz.data?.score}/${quiz.data?.total}`);
const quizNoAnswers = await call("POST", "/quizzes/submit", { token: nsToken, body: { courseId: course?._id, lessonId: quizLesson?._id } });
check("BE-QUIZ-VALID", "Quiz submit without answers returns validation message", quizNoAnswers.status === 400 && !/Cannot read/i.test(quizNoAnswers.data?.message || ""), `status=${quizNoAnswers.status} msg=${quizNoAnswers.data?.message}`);

// --- Admin assignments filter ---
const allAssign = await call("GET", "/admin/assignments", { token: adminToken });
const otherCourse = courses.data?.courses?.find((c) => !arr(allAssign.data).some((a) => a.course?._id === c._id));
const filtered = await call("GET", `/admin/assignments?courseId=${otherCourse?._id}`, { token: adminToken });
check("BE-ASSIGN-FILTER", "Admin assignments ?courseId filter works", Array.isArray(filtered.data) && Array.isArray(allAssign.data) && filtered.data.every((a) => a.course?._id === otherCourse?._id) && (allAssign.data.length === 0 || filtered.data.length < allAssign.data.length), `all=${allAssign.data?.length} filtered=${filtered.data?.length}`);

// --- Review validation ---
const subId = arr(allAssign.data)[0]?._id;
const badReview = await call("PATCH", `/admin/assignments/${subId}/review`, { token: adminToken, body: { grade: 500, status: "banana" } });
check("BE-REVIEW-VALID", "Review rejects grade>100 / invalid status", badReview.status === 400, `status=${badReview.status} saved grade=${badReview.data?.grade} status=${badReview.data?.status}`);
if (badReview.status === 200) await call("PATCH", `/admin/assignments/${subId}/review`, { token: adminToken, body: { grade: 80, status: "reviewed" } });

// --- Course validation ---
const badCourse = await call("POST", "/admin/courses", { token: adminToken, body: { title: "Neg", description: "d", instructorName: "i", price: -100 } });
check("BE-COURSE-PRICE", "Creating a course with negative price is rejected", badCourse.status === 400, `status=${badCourse.status} price=${badCourse.data?.price}`);
if (badCourse.data?._id) await call("DELETE", `/admin/courses/${badCourse.data._id}`, { token: adminToken });
const badUpdate = await call("PATCH", `/admin/courses/${course?._id}`, { token: adminToken, body: { price: -5 } });
check("BE-COURSE-UPDATE", "Updating a course to negative price is rejected", badUpdate.status === 400, `status=${badUpdate.status} price=${badUpdate.data?.price}`);
if (badUpdate.status === 200) await call("PATCH", `/admin/courses/${course?._id}`, { token: adminToken, body: { price: course.price } });

// --- Ban ---
const banTarget = await call("POST", "/auth/register", { body: { name: "Ban Me", email: `banme${uniq}@x.com`, password: "secret12" } });
await call("PATCH", `/users/${banTarget.data?.user?.id}/ban`, { token: adminToken });
const bannedLogin = await login(`banme${uniq}@x.com`, "secret12");
check("BE-BAN", "Banned user cannot log in", bannedLogin.status === 403, `status=${bannedLogin.status} msg=${bannedLogin.data?.message ?? "logged in"}`);
const bannedMe = await call("GET", "/auth/me", { token: banTarget.data?.token });
check("BE-BAN2", "Banned user's existing token is rejected", bannedMe.status === 403 || bannedMe.status === 401, `status=${bannedMe.status}`);

// --- Orphaned enrollments on course delete ---
const tmpCourse = await call("POST", "/admin/courses", { token: adminToken, body: { title: "Tmp", description: "d", instructorName: "i", price: 10 } });
await call("POST", `/enrollments/${tmpCourse.data?._id}`, { token: nsToken, body: {} });
await call("DELETE", `/admin/courses/${tmpCourse.data?._id}`, { token: adminToken });
const afterDel = await call("GET", "/enrollments/my", { token: nsToken });
const orphan = arr(afterDel.data).some((e) => !e.course);
check("BE-ORPHAN", "Deleting a course removes its enrollments (no null-course rows)", !orphan, `orphan rows present=${orphan}`);

// --- Env example ---
import fs from "node:fs";
const envExample = fs.readFileSync(new URL("../.env.example", import.meta.url), "utf8");
check("BE-ENV", ".env.example documents backend vars (MONGO_URI, JWT_SECRET)", /MONGO_URI/.test(envExample) && /JWT_SECRET/.test(envExample), envExample.split("\n").filter(Boolean).slice(0, 3).join(" | "));

for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.id.padEnd(18)} ${r.title}  -- ${r.detail}`);
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed`);
