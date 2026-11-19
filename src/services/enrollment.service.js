const mongoose = require("mongoose");
const Enrollment = require("../models/Enrollment");
const Course = require("../models/Course");

const httpError = (message, statusCode) => Object.assign(new Error(message), { statusCode });

const enrollCourse = async (studentId, courseId, batchId = null) => {
  if (!mongoose.isValidObjectId(courseId)) throw httpError("Course not found", 404);
  const course = await Course.findById(courseId);
  if (!course) throw httpError("Course not found", 404);

  // Check if already enrolled
  const existing = await Enrollment.findOne({
    student: studentId,
    course: courseId,
  });

  if (existing) {
    throw httpError("Already enrolled in this course", 400);
  }

  // Only accept a batch id that actually belongs to this course
  const validBatch =
    batchId && mongoose.isValidObjectId(batchId) && course.batches?.some((b) => String(b._id) === String(batchId));

  return Enrollment.create({
    student: studentId,
    course: courseId,
    batchId: validBatch ? batchId : null,
    progress: { completedLessons: [], percent: 0 },
  });
};

const getMyEnrollments = async (studentId) => {
  const enrollments = await Enrollment.find({ student: studentId })
    .populate("course", "title instructorName price category tags")
    .sort({ createdAt: -1 });
  // Hide enrollments whose course no longer exists
  return enrollments.filter((e) => e.course);
};

const completeLesson = async (studentId, enrollId, lessonId) => {
  if (!mongoose.isValidObjectId(enrollId)) throw httpError("Enrollment not found", 404);
  const enrollment = await Enrollment.findById(enrollId);
  if (!enrollment) throw httpError("Enrollment not found", 404);

  // A student may only update their own enrollment
  if (String(enrollment.student) !== String(studentId)) {
    throw httpError("You can only update your own enrollment", 403);
  }

  const course = await Course.findById(enrollment.course);
  if (!course) throw httpError("Course not found", 404);

  // The lesson must belong to this course
  const lessonIds = course.syllabus.flatMap((mod) => mod.lessons.map((l) => String(l._id)));
  if (!lessonId || !lessonIds.includes(String(lessonId))) {
    throw httpError("Lesson does not belong to this course", 400);
  }

  // avoid duplicates
  const alreadyDone = enrollment.progress.completedLessons
    .map(String)
    .includes(String(lessonId));

  if (!alreadyDone) {
    enrollment.progress.completedLessons.push(lessonId);
  }

  // calculate percent (only count lessons that still exist in the course)
  const totalLessons = lessonIds.length;
  const completed = enrollment.progress.completedLessons.filter((id) => lessonIds.includes(String(id))).length;
  enrollment.progress.percent =
    totalLessons === 0 ? 0 : Math.min(100, Math.round((completed / totalLessons) * 100));

  await enrollment.save();
  return enrollment;
};

module.exports = { enrollCourse, getMyEnrollments, completeLesson };
