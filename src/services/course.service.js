// service to handle course-related operations

const mongoose = require("mongoose");
const Course = require("../models/Course");

// Escape user input before using it inside a RegExp so searches such as
// "C++" or "(react" don't throw "Regular expression is invalid".
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Remove quiz answers from a course so they are not exposed publicly.
const stripQuizAnswers = (course) => {
  const obj = course.toObject ? course.toObject() : course;
  (obj.syllabus || []).forEach((mod) =>
    (mod.lessons || []).forEach((lesson) => {
      lesson.quiz = (lesson.quiz || []).map(({ correctIndex, ...rest }) => rest);
    })
  );
  return obj;
};

const getCourses = async (query, { includeAnswers = false } = {}) => {
  const {
    page = 1,
    limit = 8,
    search = "",
    sort = "",
    category,
    tags,
  } = query;

  // Validate and sanitize pagination parameters
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 8)); // Max 100 items per page

  const filter = {};

  if (search && typeof search === "string" && search.trim()) {
    const safeSearch = escapeRegex(search.trim());
    filter.$or = [
      { title: { $regex: safeSearch, $options: "i" } },
      { instructorName: { $regex: safeSearch, $options: "i" } },
    ];
  }

  if (category && typeof category === "string" && category.trim()) {
    // case-insensitive partial match so "web" finds "Web Development"
    filter.category = { $regex: escapeRegex(category.trim()), $options: "i" };
  }

  if (tags && typeof tags === "string") {
    const tagArray = tags.split(",").map(t => t.trim()).filter(t => t); // "mern,react"
    if (tagArray.length > 0) {
      // case-insensitive so "react" matches the stored tag "React"
      filter.tags = { $in: tagArray.map((t) => new RegExp(`^${escapeRegex(t)}$`, "i")) };
    }
  }

  let sortObj = {};
  if (sort === "price_asc") sortObj.price = 1;
  if (sort === "price_desc") sortObj.price = -1;

  const skip = (pageNum - 1) * limitNum;

  const [courses, total] = await Promise.all([
    Course.find(filter)
      .select(includeAnswers ? "" : "-syllabus.lessons.quiz.correctIndex")
      .sort(sortObj)
      .skip(skip)
      .limit(limitNum),
    Course.countDocuments(filter),
  ]);

  return {
    courses,
    total,
    page: pageNum,
    totalPages: Math.ceil(total / limitNum),
  };
};

const getCourseById = async (id, { includeAnswers = false } = {}) => {
  if (!mongoose.isValidObjectId(id)) throw new Error("Course not found");
  const course = await Course.findById(id);
  if (!course) throw new Error("Course not found");
  return includeAnswers ? course : stripQuizAnswers(course);
};

module.exports = { getCourses, getCourseById };
