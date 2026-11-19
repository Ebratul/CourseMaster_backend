// middleware to authenticate JWT tokens

const jwt = require("jsonwebtoken");
const User = require("../models/User");

const authMiddleware = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Not authorized" });
  }

  const token = header.split(" ")[1];

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ message: "Invalid or expired token" });
  }

  try {
    // Load the current user so bans, deletions and role changes take effect
    // immediately instead of waiting for the 30-day token to expire.
    const user = await User.findById(decoded.id).select("role isBanned");
    if (!user) {
      return res.status(401).json({ message: "User no longer exists" });
    }
    if (user.isBanned) {
      return res.status(403).json({ message: "Your account has been banned" });
    }
    req.user = { id: String(user._id), role: user.role };
    next();
  } catch (err) {
    next(err);
  }
};

// Like authMiddleware, but never rejects: attaches req.user when a valid token
// is present and continues as a guest otherwise. Used on public routes whose
// response differs for admins.
const optionalAuth = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return next();
  try {
    const decoded = jwt.verify(header.split(" ")[1], process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select("role isBanned");
    if (user && !user.isBanned) req.user = { id: String(user._id), role: user.role };
  } catch {
    // ignore invalid tokens on public routes
  }
  next();
};

module.exports = authMiddleware;
module.exports.optionalAuth = optionalAuth;
