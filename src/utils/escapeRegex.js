// Escapes special regex characters so user-supplied search strings can't
// break or hijack a $regex query (CastError on bad patterns, ReDoS risk
// on pathological ones).
exports.escapeRegex = (str = "") => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");