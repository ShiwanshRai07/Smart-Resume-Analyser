import express from "express";
import multer from "multer";
import Resume from "../models/Resume.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();

const router = express.Router();
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Gemini setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash" });

// AI-based resume parser
async function parseResumeAI(fileBuffer) {
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

  // Safely extract text
  const rawText = result.response.candidates[0].content.parts[0].text.trim();

  // Clean up the text - remove markdown code blocks if present
  let cleanText = rawText
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();

  // Ensure only JSON is parsed
  const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error("No JSON found in response:", rawText);
    throw new Error("AI did not return valid JSON");
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    
    // Helper function to normalize array fields
    const normalizeArray = (field) => {
      if (!field) return [];
      if (Array.isArray(field)) {
        // Validate array items - filter out any invalid entries
        return field.filter(item => {
          // Reject strings that look like JavaScript code
          if (typeof item === 'string' && (item.includes("' + '") || item.includes(' + '))) {
            console.warn("Rejecting malformed string that looks like code:", item.substring(0, 100));
            return false;
          }
          return true;
        });
      }
      if (typeof field === 'string') {
        // Reject strings that look like JavaScript code
        if (field.includes("' + '") || field.includes(' + ')) {
          console.warn("Rejecting malformed string that looks like code");
          return [];
        }
        // Try to parse if it's a stringified array/object
        try {
          const parsed = JSON.parse(field);
          return Array.isArray(parsed) ? parsed : [parsed];
        } catch (e) {
          // If it's a plain string, wrap in array
          return [field];
        }
      }
      // If it's an object, wrap in array
      return [field];
    };
    
    // Normalize all array fields
    parsed.skills = normalizeArray(parsed.skills);
    parsed.experience = normalizeArray(parsed.experience);
    parsed.projects = normalizeArray(parsed.projects);
    parsed.education = normalizeArray(parsed.education);
    
    // Ensure name is a string
    if (!parsed.name) parsed.name = "";
    
    return parsed;
  } catch (parseError) {
    console.error("JSON Parse Error:", parseError.message);
    console.error("Raw text (first 500 chars):", rawText.substring(0, 500));
    throw new Error(`Failed to parse JSON: ${parseError.message}`);
  }
}

// POST /api/resume/upload
router.post("/upload", upload.single("resume"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const extracted = await parseResumeAI(req.file.buffer);

    // Final validation and cleaning
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
      extracted,
      id: resume._id, // send ID so frontend can match
    });
  } catch (error) {
    console.error("AI Resume Parsing Error:", error);
    res.status(500).json({ error: error.message || "AI parsing failed" });
  }
});

export default router;