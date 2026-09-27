import express from "express";
import multer from "multer";
import Resume from "../models/Resume.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
import mammoth from "mammoth";

dotenv.config();

const router = express.Router();
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Gemini setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash" });

// Normalize the parsed JSON output
const normalizeArray = (field) => {
  if (!field) return [];
  if (Array.isArray(field)) {
    return field.filter(item => {
      if (typeof item === 'string' && (item.includes("' + '") || item.includes(' + '))) {
        return false;
      }
      return true;
    });
  }
  if (typeof field === 'string') {
    if (field.includes("' + '") || field.includes(' + ')) {
      return [];
    }
    try {
      const parsed = JSON.parse(field);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) {
      return [field];
    }
  }
  return [field];
};

function normalizeParsedResume(parsed) {
  parsed.skills = normalizeArray(parsed.skills);
  parsed.experience = normalizeArray(parsed.experience);
  parsed.projects = normalizeArray(parsed.projects);
  parsed.education = normalizeArray(parsed.education);
  if (!parsed.name) parsed.name = "";
  return parsed;
}

// AI PDF Parser
async function parseResumePdfAI(fileBuffer) {
  const result = await model.generateContent([
    {
      inlineData: {
        mimeType: "application/pdf",
        data: fileBuffer.toString("base64"),
      },
    },
    {
      text: `
        You are an AI Resume Parser. Extract information from this resume and return ONLY valid JSON.
        
        CRITICAL: Return ONLY a valid JSON object, no markdown, no code blocks, no explanations, no string concatenation.
        
        Required JSON structure:
        {
          "name": "Full Name",
          "skills": ["JavaScript", "React", "Node.js"],
          "experience": [
            {
              "title": "Job Title",
              "company": "Company Name",
              "duration": "Date Range",
              "description": "Job description"
            }
          ],
          "projects": [
            {
              "title": "Project Name",
              "date": "Date or Duration",
              "description": "Project description",
              "tech_stack": ["Tech1", "Tech2"]
            }
          ],
          "education": [
            {
              "institution": "School/University Name",
              "degree": "Degree Name",
              "field_of_study": "Field of Study",
              "date": "Date Range",
              "gpa": "GPA if available"
            }
          ]
        }
        
        IMPORTANT RULES:
        1. All fields must be valid JSON (use double quotes, proper escaping)
        2. Arrays must be actual JSON arrays, not string representations
        3. Objects must be proper JSON objects
        4. Return ONLY the JSON object, nothing else
        5. If a field is missing, use empty string "" or empty array []
      `,
    },
  ]);

  const rawText = result.response.candidates[0].content.parts[0].text.trim();
  let cleanText = rawText.replace(/```json/g, "").replace(/```/g, "").trim();

  const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error("No JSON found in response:", rawText);
    throw new Error("AI did not return valid JSON");
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return normalizeParsedResume(parsed);
  } catch (parseError) {
    console.error("JSON Parse Error:", parseError.message);
    throw new Error(`Failed to parse JSON: ${parseError.message}`);
  }
}

// AI Text Parser (for DOCX content)
async function parseResumeTextAI(text) {
  const result = await model.generateContent([
    {
      text: `
        You are an AI Resume Parser. Extract information from this resume text and return ONLY valid JSON.
        
        CRITICAL: Return ONLY a valid JSON object, no markdown, no code blocks, no explanations, no string concatenation.
        
        Required JSON structure:
        {
          "name": "Full Name",
          "skills": ["JavaScript", "React", "Node.js"],
          "experience": [
            {
              "title": "Job Title",
              "company": "Company Name",
              "duration": "Date Range",
              "description": "Job description"
            }
          ],
          "projects": [
            {
              "title": "Project Name",
              "date": "Date or Duration",
              "description": "Project description",
              "tech_stack": ["Tech1", "Tech2"]
            }
          ],
          "education": [
            {
              "institution": "School/University Name",
              "degree": "Degree Name",
              "field_of_study": "Field of Study",
              "date": "Date Range",
              "gpa": "GPA if available"
            }
          ]
        }
        
        IMPORTANT RULES:
        1. All fields must be valid JSON (use double quotes, proper escaping)
        2. Arrays must be actual JSON arrays, not string representations
        3. Objects must be proper JSON objects
        4. Return ONLY the JSON object, nothing else
        5. If a field is missing, use empty string "" or empty array []

        Resume text:
        ${text}
      `,
    },
  ]);

  const rawText = result.response.candidates[0].content.parts[0].text.trim();
  let cleanText = rawText.replace(/```json/g, "").replace(/```/g, "").trim();

  const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error("No JSON found in response:", rawText);
    throw new Error("AI did not return valid JSON");
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return normalizeParsedResume(parsed);
  } catch (parseError) {
    console.error("JSON Parse Error:", parseError.message);
    throw new Error(`Failed to parse JSON: ${parseError.message}`);
  }
}

// POST /api/recruiter/upload
router.post("/upload", upload.single("resume"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    let extracted;
    const isPdf = req.file.mimetype === "application/pdf" || req.file.originalname.toLowerCase().endsWith(".pdf");
    const isDocx = req.file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || req.file.originalname.toLowerCase().endsWith(".docx");

    if (isPdf) {
      extracted = await parseResumePdfAI(req.file.buffer);
    } else if (isDocx) {
      const mammothResult = await mammoth.extractRawText({ buffer: req.file.buffer });
      const text = mammothResult.value;
      extracted = await parseResumeTextAI(text);
    } else {
      return res.status(400).json({ error: "Unsupported file type. Please upload a PDF or DOCX file." });
    }

    const cleanedExtracted = {
      name: extracted.name || "",
      skills: Array.isArray(extracted.skills) ? extracted.skills.filter(s => typeof s === 'string') : [],
      experience: Array.isArray(extracted.experience) ? extracted.experience : [],
      projects: Array.isArray(extracted.projects) ? extracted.projects : [],
      education: Array.isArray(extracted.education) ? extracted.education : [],
      text: extracted.text || "",
      email: extracted.email || "",
      phone: extracted.phone || "",
    };

    const resume = new Resume({
      filename: req.file.originalname,
      contentType: req.file.mimetype,
      data: req.file.buffer,
      extracted: cleanedExtracted,
    });

    await resume.save();

    res.json({
      message: "Resume uploaded & AI-parsed successfully",
      extracted: cleanedExtracted,
      id: resume._id,
    });
  } catch (error) {
    console.error("Recruiter Resume Upload Error:", error);
    res.status(500).json({ error: error.message || "Resume upload and parsing failed" });
  }
});

export default router;
