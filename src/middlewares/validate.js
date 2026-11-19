// middleware to validate request bodies against Zod schemas

const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body ?? {});
  if (!result.success) {
    const errors = result.error.issues.map((issue) => ({
      field: issue.path.join("."),
      message: issue.message,
    }));
    return res.status(400).json({
      // surface the first problem so the UI can show something meaningful
      message: errors[0]?.message || "Validation error",
      errors,
    });
  }
  req.body = result.data;
  next();
};

module.exports = validate;
