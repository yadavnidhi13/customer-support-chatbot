
const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const FAQ_FILE = path.join(ROOT_DIR, "faqs.json");
const FEEDBACK_FILE = path.join(ROOT_DIR, "feedback.json");
const ORDERS_FILE = path.join(ROOT_DIR, "orders.json");
const UPLOAD_DIR = path.join(ROOT_DIR, "uploads");
const UPLOADS_LOG = path.join(ROOT_DIR, "uploads.json");

// --------------------------------------------------
// Read .env without requiring an extra package
// --------------------------------------------------

const ENV_FILE = path.join(ROOT_DIR, ".env");

if (fs.existsSync(ENV_FILE)) {
  const envText = fs.readFileSync(ENV_FILE, "utf8");

  for (const line of envText.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();

    value = value.replace(/^(['"])(.*)\1$/, "$2");

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_PASSWORD) {
  console.error(
    "Missing ADMIN_PASSWORD. Add it to your private .env file."
  );
  process.exit(1);
}

// --------------------------------------------------
// Folders and middleware
// --------------------------------------------------

for (const directory of [PUBLIC_DIR, UPLOAD_DIR]) {
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// Serve the existing frontend and uploaded files.
app.use(express.static(PUBLIC_DIR));
app.use("/uploads", express.static(UPLOAD_DIR));

// --------------------------------------------------
// JSON file helpers
// --------------------------------------------------

function readJSON(filePath, fallbackValue) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallbackValue;
    }

    const content = fs.readFileSync(filePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    console.error(`Could not read ${path.basename(filePath)}:`, error.message);
    return fallbackValue;
  }
}

function writeJSON(filePath, data) {
  const temporaryPath = `${filePath}.tmp`;

  fs.writeFileSync(
    temporaryPath,
    JSON.stringify(data, null, 2),
    "utf8"
  );

  fs.renameSync(temporaryPath, filePath);
}

function makeId() {
  return crypto.randomUUID();
}

function getFAQs() {
  const faqs = readJSON(FAQ_FILE, []);

  if (!Array.isArray(faqs)) {
    throw new Error("faqs.json must contain a JSON array.");
  }

  return faqs;
}

function getFeedback() {
  const feedback = readJSON(FEEDBACK_FILE, []);
  return Array.isArray(feedback) ? feedback : [];
}

function getOrders() {
  const orders = readJSON(ORDERS_FILE, []);
  return Array.isArray(orders) ? orders : [];
}

// Validate the FAQ file when the server starts.
try {
  getFAQs();
} catch (error) {
  console.error("FAQ setup error:", error.message);
  process.exit(1);
}

// --------------------------------------------------
// Admin authentication
// --------------------------------------------------

// The existing admin page can continue sending the
// x-admin-password header.
//
// Never put your admin password in public HTML.
function requireAdmin(req, res, next) {
  const suppliedPassword = req.get("x-admin-password") || "";

  const expectedBuffer = Buffer.from(ADMIN_PASSWORD);
  const suppliedBuffer = Buffer.from(suppliedPassword);

  const passwordMatches =
    expectedBuffer.length === suppliedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);

  if (!passwordMatches) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized. Please check your admin password."
    });
  }

  next();
}

// --------------------------------------------------
// Smart rule-based FAQ matching
// --------------------------------------------------

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SYNONYMS = {
  refund: ["money back", "reimbursement", "repayment"],
  return: ["send back", "exchange", "returning"],
  order: ["purchase", "parcel", "package", "shipment"],
  tracking: ["track", "where is", "delivery status", "shipment status"],
  delivery: ["shipping", "deliver", "arrive", "arrival"],
  contact: ["reach", "call", "email", "speak to", "talk to"],
  support: ["help", "assistance", "customer care", "customer service"],
  hours: ["timing", "time", "open", "working hours", "availability"],
  cancel: ["cancellation", "stop order", "cancel order"],
  payment: ["paid", "pay", "transaction", "billing"]
};

function expandMessage(message) {
  let expanded = normalizeText(message);

  for (const [keyword, alternatives] of Object.entries(SYNONYMS)) {
    for (const alternative of alternatives) {
      if (expanded.includes(alternative)) {
        expanded += ` ${keyword}`;
      }
    }
  }

  return normalizeText(expanded);
}

function getFAQSearchText(faq) {
  const fields = [
    faq.question,
    faq.answer,
    faq.category,
    faq.keywords,
    faq.tags,
    faq.questions,
    faq.alternateQuestions,
    faq.alternate_questions
  ];

  return fields
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter(Boolean)
    .join(" ");
}

function findFAQ(message) {
  const originalMessage = normalizeText(message);
  const searchMessage = expandMessage(message);

  if (!originalMessage) return null;

  const faqs = getFAQs();
  let bestFAQ = null;
  let bestScore = 0;

  for (const faq of faqs) {
    if (!faq || typeof faq !== "object") continue;

    const question = normalizeText(faq.question || "");
    const expandedQuestion = expandMessage(faq.question || "");
    const searchText = normalizeText(getFAQSearchText(faq));
    const expandedSearchText = expandMessage(getFAQSearchText(faq));

    if (!question || !faq.answer) continue;

    // Exact question match.
    if (originalMessage === question) {
      return faq;
    }

    // Match a known question contained in a longer message.
    if (
      question.length > 5 &&
      (originalMessage.includes(question) ||
        question.includes(originalMessage))
    ) {
      return faq;
    }

    let score = 0;

    // Reward overlapping meaningful words.
    const stopWords = new Set([
      "the", "a", "an", "is", "are", "am", "i", "we", "you",
      "my", "our", "your", "me", "to", "for", "of", "in", "on",
      "do", "does", "can", "could", "would", "please", "tell",
      "what", "how", "when", "where", "why", "and", "or",
      "it", "this", "that", "about", "want", "know", "with"
    ]);

    const messageWords = [...new Set(
      searchMessage
        .split(" ")
        .filter((word) => word.length > 1 && !stopWords.has(word))
    )];

    const questionWords = new Set(
      expandedQuestion
        .split(" ")
        .filter((word) => word.length > 1 && !stopWords.has(word))
    );

    const allFAQWords = new Set(
      expandedSearchText
        .split(" ")
        .filter((word) => word.length > 1 && !stopWords.has(word))
    );

    for (const word of messageWords) {
      if (questionWords.has(word)) score += 3;
      else if (allFAQWords.has(word)) score += 1;
    }

    // Give a small boost when a whole keyword is matched.
    const keywordValues = [
      ...(Array.isArray(faq.keywords) ? faq.keywords : []),
      ...(Array.isArray(faq.tags) ? faq.tags : [])
    ];

    for (const keyword of keywordValues) {
      const normalizedKeyword = normalizeText(keyword);

      if (
        normalizedKeyword &&
        searchMessage.includes(normalizedKeyword)
      ) {
        score += 2;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestFAQ = faq;
    }
  }

  // Avoid returning a random FAQ for unrelated questions.
  return bestScore >= 2 ? bestFAQ : null;
}

function createFallbackReply() {
  return (
    "I'm not sure I understood that question. You can ask me about " +
    "returns, order tracking, delivery, or contacting customer support."
  );
}

// --------------------------------------------------
// Customer chat API
// --------------------------------------------------

app.post("/chat", (req, res) => {
  try {
    const message = req.body?.message;

    if (typeof message !== "string" || !message.trim()) {
      return res.status(400).json({
        success: false,
        error: "Please enter a message."
      });
    }

    if (message.length > 2000) {
      return res.status(413).json({
        success: false,
        error: "Your message is too long. Please shorten it."
      });
    }

    const faq = findFAQ(message.trim());

    return res.json({
      success: true,
      reply: faq ? faq.answer : createFallbackReply(),
      matched: Boolean(faq),
      faqId: faq ? (faq.id || null) : null
    });
  } catch (error) {
    console.error("Chat error:", error.message);

    return res.status(500).json({
      success: false,
      error: "Something went wrong. Please try again."
    });
  }
});

// --------------------------------------------------
// Customer feedback: helpful rating and comments
// --------------------------------------------------

app.post("/api/feedback", (req, res) => {
  try {
    const { helpful, rating, comment, message, answer } = req.body || {};

    const isHelpfulValue =
      helpful === true ||
      helpful === false ||
      helpful === "yes" ||
      helpful === "no";

    const hasRating =
      rating !== undefined &&
      Number.isInteger(Number(rating)) &&
      Number(rating) >= 1 &&
      Number(rating) <= 5;

    const cleanComment =
      typeof comment === "string" ? comment.trim().slice(0, 1000) : "";

    if (!isHelpfulValue && !hasRating && !cleanComment) {
      return res.status(400).json({
        success: false,
        error: "Please provide feedback, a rating, or a comment."
      });
    }

    const feedback = getFeedback();

    const entry = {
      id: makeId(),
      helpful:
        helpful === true || helpful === "yes"
          ? "yes"
          : helpful === false || helpful === "no"
            ? "no"
            : null,
      rating: hasRating ? Number(rating) : null,
      comment: cleanComment,
      message:
        typeof message === "string" ? message.trim().slice(0, 2000) : "",
      answer:
        typeof answer === "string" ? answer.trim().slice(0, 2000) : "",
      createdAt: new Date().toISOString()
    };

    feedback.push(entry);
    writeJSON(FEEDBACK_FILE, feedback);

    return res.json({
      success: true,
      message: "Thank you for your feedback!"
    });
  } catch (error) {
    console.error("Feedback error:", error.message);

    return res.status(500).json({
      success: false,
      error: "Could not save your feedback."
    });
  }
});

// --------------------------------------------------
// Demo order tracking
// --------------------------------------------------

// Creates example orders if orders.json does not exist.
// Replace these examples with your own demo data.
if (!fs.existsSync(ORDERS_FILE)) {
  writeJSON(ORDERS_FILE, [
    {
      orderId: "NINI1001",
      status: "Processing",
      estimatedDelivery: "Within 3-5 business days",
      items: ["Demo item"],
      updatedAt: new Date().toISOString()
    },
    {
      orderId: "NINI1002",
      status: "Shipped",
      estimatedDelivery: "Within 1-2 business days",
      items: ["Demo item"],
      updatedAt: new Date().toISOString()
    },
    {
      orderId: "NINI1003",
      status: "Delivered",
      estimatedDelivery: "Delivered",
      items: ["Demo item"],
      updatedAt: new Date().toISOString()
    }
  ]);
}

app.get("/api/orders/:orderId", (req, res) => {
  try {
    const requestedId = String(req.params.orderId || "")
      .trim()
      .toLowerCase();

    if (!requestedId || requestedId.length > 80) {
      return res.status(400).json({
        success: false,
        error: "Please enter a valid order ID."
      });
    }

    const order = getOrders().find(
      (item) =>
        String(item.orderId || "").toLowerCase() === requestedId
    );

    if (!order) {
      return res.status(404).json({
        success: false,
        error: "We couldn't find that demo order. Check the order ID."
      });
    }

    return res.json({
      success: true,
      order: {
        orderId: order.orderId,
        status: order.status,
        estimatedDelivery: order.estimatedDelivery,
        updatedAt: order.updatedAt
      }
    });
  } catch (error) {
    console.error("Order lookup error:", error.message);

    return res.status(500).json({
      success: false,
      error: "Could not look up this order."
    });
  }
});

// --------------------------------------------------
// Image/file upload
// --------------------------------------------------

const allowedMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "text/plain"
]);

const storage = multer.diskStorage({
  destination: (req, file, callback) => {
    callback(null, UPLOAD_DIR);
  },
  filename: (req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    callback(null, `${makeId()}${extension}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1
  },
  fileFilter: (req, file, callback) => {
    if (!allowedMimeTypes.has(file.mimetype)) {
      return callback(
        new Error("Unsupported file type. Use JPG, PNG, GIF, WEBP, PDF, or TXT.")
      );
    }

    callback(null, true);
  }
});

app.post("/api/upload", (req, res) => {
  upload.single("file")(req, res, (error) => {
    if (error) {
      const message =
        error.code === "LIMIT_FILE_SIZE"
          ? "File too large. Maximum size is 5 MB."
          : error.message || "File upload failed.";

      return res.status(400).json({
        success: false,
        error: message
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file received. Send it in the "file" field.'
      });
    }

const uploadRecord = {
  id: makeId(),
  name: path.basename(req.file.originalname),
  filename: req.file.filename,
  url: `/uploads/${req.file.filename}`,
  size: req.file.size,
  type: req.file.mimetype,
  uploadedAt: new Date().toISOString()
};

const uploadRecords = readJSON(UPLOADS_LOG, []);

if (!Array.isArray(uploadRecords)) {
  return res.status(500).json({
    success: false,
    error: "Upload log is invalid."
  });
}

uploadRecords.push(uploadRecord);
writeJSON(UPLOADS_LOG, uploadRecords);

return res.json({
  success: true,
  file: uploadRecord
});

  });
});

// --------------------------------------------------
// Admin API: FAQ management
// --------------------------------------------------

app.get("/api/admin/faqs", requireAdmin, (req, res) => {
  try {
    return res.json(getFAQs());
  } catch (error) {
    console.error("Admin FAQ read error:", error.message);

    return res.status(500).json({
      success: false,
      error: "Could not load FAQs."
    });
  }
});

app.post("/api/admin/faqs", requireAdmin, (req, res) => {
  try {
    const { question, answer, keywords, category } = req.body || {};

    if (
      typeof question !== "string" ||
      !question.trim() ||
      typeof answer !== "string" ||
      !answer.trim()
    ) {
      return res.status(400).json({
        success: false,
        error: "Question and answer are required."
      });
    }

    const faqs = getFAQs();

    const faq = {
      id: makeId(),
      question: question.trim().slice(0, 500),
      answer: answer.trim().slice(0, 5000),
      keywords: Array.isArray(keywords)
        ? keywords.filter((item) => typeof item === "string").slice(0, 30)
        : typeof keywords === "string"
          ? keywords.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 30)
          : [],
      category:
        typeof category === "string" ? category.trim().slice(0, 100) : ""
    };

    faqs.push(faq);
    writeJSON(FAQ_FILE, faqs);

    return res.status(201).json({
      success: true,
      faq
    });
  } catch (error) {
    console.error("Admin FAQ create error:", error.message);

    return res.status(500).json({
      success: false,
      error: "Could not create FAQ."
    });
  }
});

app.put("/api/admin/faqs/:id", requireAdmin, (req, res) => {
  try {
    const faqs = getFAQs();
    const index = faqs.findIndex(
      (faq) => String(faq.id) === String(req.params.id)
    );

    if (index === -1) {
      return res.status(404).json({
        success: false,
        error: "FAQ not found."
      });
    }

    const { question, answer, keywords, category } = req.body || {};
    const updated = { ...faqs[index] };

    if (question !== undefined) {
      if (typeof question !== "string" || !question.trim()) {
        return res.status(400).json({
          success: false,
          error: "Question cannot be empty."
        });
      }

      updated.question = question.trim().slice(0, 500);
    }

    if (answer !== undefined) {
      if (typeof answer !== "string" || !answer.trim()) {
        return res.status(400).json({
          success: false,
          error: "Answer cannot be empty."
        });
      }

      updated.answer = answer.trim().slice(0, 5000);
    }

    if (keywords !== undefined) {
      updated.keywords = Array.isArray(keywords)
        ? keywords.filter((item) => typeof item === "string").slice(0, 30)
        : typeof keywords === "string"
          ? keywords.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 30)
          : [];
    }

    if (category !== undefined) {
      updated.category =
        typeof category === "string" ? category.trim().slice(0, 100) : "";
    }

    faqs[index] = updated;
    writeJSON(FAQ_FILE, faqs);

    return res.json({
      success: true,
      faq: updated
    });
  } catch (error) {
    console.error("Admin FAQ update error:", error.message);

    return res.status(500).json({
      success: false,
      error: "Could not update FAQ."
    });
  }
});

app.delete("/api/admin/faqs/:id", requireAdmin, (req, res) => {
  try {
    const faqs = getFAQs();
    const updatedFAQs = faqs.filter(
      (faq) => String(faq.id) !== String(req.params.id)
    );

    if (updatedFAQs.length === faqs.length) {
      return res.status(404).json({
        success: false,
        error: "FAQ not found."
      });
    }

    writeJSON(FAQ_FILE, updatedFAQs);

    return res.json({
      success: true,
      message: "FAQ deleted."
    });
  } catch (error) {
    console.error("Admin FAQ delete error:", error.message);

    return res.status(500).json({
      success: false,
      error: "Could not delete FAQ."
    });
  }
});

// --------------------------------------------------
// Admin API: customer feedback
// --------------------------------------------------

app.get("/api/admin/feedback", requireAdmin, (req, res) => {
  try {
    const feedback = getFeedback().slice().reverse();

    return res.json(feedback);
  } catch (error) {
    console.error("Admin feedback error:", error.message);

    return res.status(500).json({
      success: false,
      error: "Could not load feedback."
    });
  }
});

app.get("/api/admin/uploads", requireAdmin, (req, res) => {
  const uploads = readJSON(UPLOADS_LOG, []);

  if (!Array.isArray(uploads)) {
    return res.status(500).json({
      success: false,
      error: "Upload log is invalid."
    });
  }

  // Return newest uploads first.
  uploads.sort((a, b) =>
    new Date(b.uploadedAt) - new Date(a.uploadedAt)
  );

  res.json({
    success: true,
    uploads
  });
});


// --------------------------------------------------
// Health check and error handling
// --------------------------------------------------

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    name: "Nini Support",
    status: "running"
  });
});

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({
      success: false,
      error: "API route not found."
    });
  }

  return res.status(404).send("Page not found.");
});

app.use((error, req, res, next) => {
  console.error("Unexpected server error:", error.message);

  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({
    success: false,
    error: "An unexpected server error occurred."
  });
});

// --------------------------------------------------
// Start server
// --------------------------------------------------

app.listen(PORT, () => {
  console.log(`Nini Support is running at http://localhost:${PORT}`);
});
