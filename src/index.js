// QuizAI Server - Express.js Application
// Dependencies to install:
// npm i express hbs mongoose multer pdf-parse mammoth pptx2json @google/generative-ai dotenv nodemon express-session
// Run with: nodemon src/index.js

const express = require("express")
const app = express()
const path = require("path")
const hbs = require("hbs")
const multer = require("multer")
const fs = require("fs")
const pdfParse = require("pdf-parse")
const mammoth = require("mammoth")
// --- SESSION CHANGE ---
const session = require('express-session');
// --- END SESSION CHANGE ---

// Fix for pptx2json import/usage
const { toJson } = require("pptx2json") // Correct import for pptx2json

// Load environment variables from .env file (for API keys, etc.)
require('dotenv').config()

// Import database collections
const { studentCollection, teacherCollection, lectureCollection, quizCollection, quizResultCollection } = require("./mongodb")

// Google Gemini API setup
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai')
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
const model = genAI.getGenerativeModel({ model: "gemini-pro" }) // "gemini-pro" for text-only

// Configuration
const PORT = 3000
const TEMP_UPLOAD_DIR = './temp_uploads'
const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100MB
const templatePath = path.join(__dirname, '../tempelates')

// Removed: Define permanent upload directory (No longer needed as files are not stored permanently)
// const UPLOADS_DIR = path.join(__dirname, '../uploads'); // Permanent storage location

// Express configuration
app.use(express.json()) // For parsing application/json
app.use(express.urlencoded({ extended: false })) // For parsing application/x-www-form-urlencoded (form data)
app.set("view engine", "hbs") // Set Handlebars as the view engine
app.set("views", templatePath) // Set the directory for view files

// --- SESSION CHANGE ---
app.use(session({
    secret: process.env.SESSION_SECRET || 'a_very_secret_key_for_quizai', // Use a strong, random string from .env
    resave: false, // Don't save session if unmodified
    saveUninitialized: false, // Don't create session until something stored
    cookie: {
        maxAge: 1000 * 60 * 60 * 24, // 1 day in milliseconds
        // secure: true, // Uncomment in production if using HTTPS
        httpOnly: true // Prevents client-side JS from accessing the cookie
    }
}));
// --- END SESSION CHANGE ---

// Middleware to check if user is authenticated (simple example)
// You might want more sophisticated role-based access control here
const isAuthenticated = (req, res, next) => {
    if (req.session.userId) {
        next(); // User is authenticated, proceed
    } else {
        res.redirect('/login?message=Please login to access this page.'); // Redirect to login
    }
};

// ==================== FILE UPLOAD CONFIGURATION ====================

// Configure multer for temporary file storage
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        if (!fs.existsSync(TEMP_UPLOAD_DIR)) {
            fs.mkdirSync(TEMP_UPLOAD_DIR)
        }
        cb(null, TEMP_UPLOAD_DIR)
    },
    filename: function (req, file, cb) {
        const uniqueName = Date.now() + '-' + file.originalname
        cb(null, uniqueName)
    }
})

// File type validation
const fileFilter = (req, file, cb) => {
    const allowedMimes = [
        'application/pdf',
        'application/vnd.ms-powerpoint', // .ppt
        'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
        'application/msword', // .doc
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document' // .docx
    ]

    if (allowedMimes.includes(file.mimetype)) {
        cb(null, true)
    } else {
        req.fileError = new Error('Invalid file type. Only PDF, PPT, PPTX, DOC, DOCX files are allowed.');
        cb(null, false);
    }
}

// Multer configuration
const upload = multer({
    storage: storage,
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: fileFilter
})

// ==================== TEXT EXTRACTION FUNCTIONS ====================

/**
 * Extract text from PDF files
 * @param {string} filePath - Path to the PDF file
 * @returns {Promise<string>} - Extracted text content
 */
async function extractTextFromPDF(filePath) {
    try {
        const dataBuffer = fs.readFileSync(filePath)
        const data = await pdfParse(dataBuffer)
        console.log(`✅ PDF text extracted - Length: ${data.text.length} characters`)
        return data.text
    } catch (error) {
        console.error('❌ PDF extraction error:', error)
        throw new Error('Failed to extract text from PDF')
    }
}

/**
 * Extract text from Word documents (.doc, .docx)
 * @param {string} filePath - Path to the Word document
 * @returns {Promise<string>} - Extracted text content
 */
async function extractTextFromWord(filePath) {
    try {
        const result = await mammoth.extractRawText({ path: filePath })
        console.log(`✅ Word text extracted - Length: ${result.value.length} characters`)
        return result.value
    } catch (error) {
        console.error('❌ Word extraction error:', error)
        throw new Error('Failed to extract text from Word document')
    }
}

/**
 * Extract text from PowerPoint presentations (.ppt, .pptx)
 * @param {string} filePath - Path to the PowerPoint file
 * @returns {Promise<string>} - Extracted text content
 */
async function extractTextFromPowerPoint(filePath) {
    try {
        // --- SESSION CHANGE - pptx2json usage fix ---
        const data = await toJson(filePath) // Use the destructured toJson
        // --- END SESSION CHANGE ---
        let extractedText = ''

        if (data && data.slides) {
            data.slides.forEach((slide, index) => {
                extractedText += `\n--- Slide ${index + 1} ---\n`
                if (slide.content) {
                    slide.content.forEach(content => {
                        if (content.text) {
                            extractedText += content.text + '\n'
                        }
                    })
                }
            })
        }

        console.log(`✅ PowerPoint text extracted - Length: ${extractedText.length} characters`)
        return extractedText || "No text found in PowerPoint file"
    } catch (error) {
        console.error('❌ PowerPoint extraction error:', error)
        return "PowerPoint file uploaded successfully. Text extraction failed, but content is available."
    }
}

/**
 * Main text extraction function - routes to appropriate extractor
 * @param {string} filePath - Path to the file
 * @param {string} mimetype - MIME type of the file
 * @returns {Promise<string>} - Extracted text content
 */
async function extractTextFromFile(filePath, mimetype) {
    console.log(`🔄 Starting text extraction for: ${mimetype}`)

    switch (mimetype) {
        case 'application/pdf':
            return await extractTextFromPDF(filePath)
        case 'application/msword':
        case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
            return await extractTextFromWord(filePath)
        case 'application/vnd.ms-powerpoint':
        case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
            return await extractTextFromPowerPoint(filePath)
        default:
            throw new Error('Unsupported file type')
    }
}

// ==================== UTILITY FUNCTIONS ====================

/**
 * Get file type string from MIME type
 * @param {string} mimetype - MIME type
 * @returns {string} - File type string
 */
function getFileType(mimetype) {
    const typeMap = {
        'application/pdf': 'pdf',
        'application/msword': 'docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'application/vnd.ms-powerpoint': 'pptx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx'
    }
    return typeMap[mimetype] || 'unknown'
}

/**
 * Clean up temporary files after processing
 * @param {string} filePath - Path to the temporary file
 */
function cleanupTempFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath)
            console.log(`🗑️ Temporary file deleted: ${filePath}`)
        }
    } catch (error) {
        console.error('⚠️ Error cleaning up temporary file:', error)
    }
}

/**
 * Clean up all temporary files in the temp directory
 */
function cleanupTempFiles() {
    if (fs.existsSync(TEMP_UPLOAD_DIR)) {
        const files = fs.readdirSync(TEMP_UPLOAD_DIR)
        files.forEach(file => {
            const filePath = path.join(TEMP_UPLOAD_DIR, file)
            try {
                fs.unlinkSync(filePath)
                console.log(`🗑️ Cleaned up old temp file: ${file}`)
            } catch (error) {
                console.error(`⚠️ Could not clean up temp file ${file}:`, error)
            }
        })
    }
}

// ==================== AUTHENTICATION ROUTES ====================

// Root route - redirect to login
app.get("/", (req, res) => {
    res.redirect("/login")
})

// Render login page
app.get("/login", (req, res) => {
    res.render("login", { message: req.query.message }); // Pass message for display
})

// Render signup page
app.get("/signup", (req, res) => {
    res.render("signup")
})

// Handle user registration
app.post("/signup", async (req, res) => {
    try {
        const { userType, name, email, enrollment, password } = req.body

        if (userType === 'teacher') {
            const teacherData = { name, email, password }
            await teacherCollection.insertMany([teacherData])
            // --- SESSION CHANGE ---
            const newTeacher = await teacherCollection.findOne({ email: email }); // Fetch the newly created teacher to get their _id
            req.session.userId = newTeacher._id;
            req.session.userName = newTeacher.name;
            req.session.userType = userType; // Store user type in session as well
            res.redirect(`/homeTeacher?userName=${encodeURIComponent(newTeacher.name)}`);
            // --- END SESSION CHANGE ---
        } else {
            const studentData = { name, enrollment, password }
            await studentCollection.insertMany([studentData])
            // --- SESSION CHANGE ---
            const newStudent = await studentCollection.findOne({ enrollment: enrollment }); // Fetch the newly created student
            req.session.userId = newStudent._id;
            req.session.userName = newStudent.name;
            req.session.userType = userType; // Store user type in session as well
            res.redirect(`/homeStudent?userName=${encodeURIComponent(newStudent.name)}`);
            // --- END SESSION CHANGE ---
        }
    } catch (error) {
        console.error('❌ Signup error:', error)
        res.send("Error during registration")
    }
})

// Handle user login
app.post("/login", async (req, res) => {
    try {
        const { password, userType, email, enrollment } = req.body
        let user

        if (userType === 'teacher') {
            user = await teacherCollection.findOne({ email: email })
        } else { // Student
            user = await studentCollection.findOne({ enrollment: enrollment })
        }

        if (user && user.password === password) {
            // --- SESSION CHANGE ---
            req.session.userId = user._id;
            req.session.userName = user.name;
            req.session.userType = userType; // Store user type in session as well
            // --- END SESSION CHANGE ---

            const redirectUrl = userType === 'teacher' ? '/homeTeacher' : '/homeStudent'
            res.redirect(`${redirectUrl}?userName=${encodeURIComponent(user.name)}`)
        } else {
            res.send("Wrong credentials")
        }
    } catch (error) {
        console.error('❌ Login error:', error)
        res.send("Login failed")
    }
})

// Logout route
app.get('/logout', (req, res) => {
    // --- SESSION CHANGE ---
    req.session.destroy(err => {
        if (err) {
            console.error('Error destroying session:', err);
            return res.status(500).send('Could not log out.');
        }
        res.redirect('/login?message=You have been logged out.');
    });
    // --- END SESSION CHANGE ---
})

// ==================== DASHBOARD ROUTES ====================

// Student dashboard
// --- SESSION CHANGE - Add isAuthenticated middleware ---
app.get("/homeStudent", isAuthenticated, async (req, res) => {
    res.render("homeStudent", {
        userType: req.session.userType || "student", // Get from session
        userName: req.session.userName || "Student", // Get from session
    })
})
// --- END SESSION CHANGE ---

// Teacher dashboard with lecture statistics
// --- SESSION CHANGE - Add isAuthenticated middleware ---
app.get("/homeTeacher", isAuthenticated, async (req, res) => {
    try {
        // Ensure only teacher users can access this dashboard
        if (req.session.userType !== 'teacher') {
            return res.status(403).redirect('/login?message=Access denied. Not a teacher account.');
        }

        // Get teacher's lectures from QuizAI database
        // --- SESSION CHANGE - Filter lectures by professorId from session ---
        const lectures = await lectureCollection.find({ professorId: req.session.userId }).sort({ uploadDate: -1 }).lean()
        // --- END SESSION CHANGE ---

        // Calculate stats from actual data
        const stats = {
            totalLectures: lectures.length,
            quizzesGenerated: lectures.filter(lecture => lecture.quizGenerated).length,
            pendingLectures: lectures.filter(lecture => !lecture.quizGenerated).length,
            totalStudents: await studentCollection.countDocuments() // This counts all students, not just teacher's
        }

        // Format lectures for display
        const formattedLectures = lectures.map(lecture => ({
            id: lecture._id,
            title: lecture.title,
            uploadDate: lecture.uploadDate ? lecture.uploadDate.toLocaleDateString() : 'N/A', // Added check for uploadDate
            quizGenerated: lecture.quizGenerated,
            originalFileName: lecture.originalFileName,
            fileType: lecture.fileType,
            textLength: lecture.textLength,
            processingStatus: lecture.processingStatus
        }))

        res.render("homeTeacher", {
            userType: req.session.userType || "teacher", // Get from session
            userName: req.session.userName || "Teacher", // Get from session
            ...stats,
            lectures: formattedLectures,
            uploadSuccess: req.query.upload === 'success', // For HBS template messages
            uploadError: req.query.uploadError === 'true',
            message: req.query.message,
            uploadedTitle: req.query.title // Used to display uploaded title
        })
    } catch (error) {
        console.error('❌ Error loading teacher dashboard:', error)
        res.status(500).render("homeTeacher", { // Render with error status
            userType: req.session.userType || "teacher",
            userName: req.session.userName || "Teacher",
            totalLectures: 0,
            quizzesGenerated: 0,
            pendingLectures: 0,
            totalStudents: 0,
            lectures: [],
            uploadError: true,
            message: 'Failed to load dashboard: ' + error.message
        })
    }
})


// ==================== LECTURE MANAGEMENT ROUTES ====================

// Upload and process lecture files
// --- SESSION CHANGE - Add isAuthenticated middleware ---
app.post("/upload_lecture", isAuthenticated, upload.single('lectureFile'), async (req, res) => {
    let tempFilePath = null;
    // Removed: permanentFilePath variable as files are not stored permanently

    try {
        // Removed: Ensure the permanent uploads directory exists (No longer needed)
        // if (!fs.existsSync(UPLOADS_DIR)) {
        //     fs.mkdirSync(UPLOADS_DIR, { recursive: true });
        // }

        // Handle file upload errors from Multer's fileFilter
        if (req.fileError) {
            return res.status(400).redirect(`/homeTeacher?uploadError=true&message=${encodeURIComponent(req.fileError.message)}`);
        }

        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'No file uploaded'
            });
        }

        const { title } = req.body;
        const file = req.file;
        tempFilePath = file.path;

        console.log('📁 Processing file:', {
            originalName: file.originalname,
            size: file.size,
            mimetype: file.mimetype,
            tempPath: file.path
        });

        // --- SESSION CHANGE - Get Professor Information from Session ---
        const professorId = req.session.userId;
        const professorName = req.session.userName;

        if (!professorId || !professorName || req.session.userType !== 'teacher') {
            console.warn('⚠️ User not identified as a teacher in session for lecture upload.');
            // Destroy session and redirect to login if session data is missing or user type is wrong
            return req.session.destroy(err => {
                const message = encodeURIComponent('Authentication required. Please log in as a teacher.');
                res.status(401).redirect(`/login?message=${message}`);
            });
        }
        // --- END SESSION CHANGE ---

        // Extract text from uploaded file
        const extractedText = await extractTextFromFile(file.path, file.mimetype);

        console.log('📝 Text extraction completed:', {
            totalLength: extractedText.length,
            preview: extractedText.substring(0, 200) + '...'
        });

        // --- NEW: Clean up temporary file IMMEDIATELY after extraction ---
        cleanupTempFile(tempFilePath);
        console.log(`🗑️ Temporary file cleaned up after extraction.`);

        // Removed: Move the file to permanent storage (No longer needed)
        // permanentFilePath = path.join(UPLOADS_DIR, file.filename);
        // await fs.promises.rename(tempFilePath, permanentFilePath);
        // console.log(`➡️ File moved to permanent storage: ${permanentFilePath}`);


        // Save extracted text and metadata to database
        const lectureData = {
            title: title,
            filePath: '', // filePath is now empty/null as the file is not stored permanently
            originalFileName: file.originalname,
            mimeType: file.mimetype,
            fileSize: file.size,
            extractedText: extractedText,
            textLength: extractedText.length,
            uploadDate: new Date(),
            fileType: getFileType(file.mimetype),
            quizGenerated: false,
            processingStatus: 'completed',
            professorName: professorName, // From session
            professorId: professorId      // From session
        };

        const savedLecture = await lectureCollection.create(lectureData);
        console.log('✅ Lecture saved to database:', savedLecture._id);

        res.redirect(`/homeTeacher?upload=success&title=${encodeURIComponent(title)}`);

    } catch (error) {
        console.error('❌ Upload processing error:', error);

        // Still clean up temp file if error occurred before deletion
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            cleanupTempFile(tempFilePath);
        }
        // Removed: Cleanup for permanentFilePath as it's not created

        const currentUserName = req.session.userName || 'Teacher';
        res.status(500).redirect(`/homeTeacher?uploadError=true&message=${encodeURIComponent('Failed to process uploaded file: ' + error.message)}`);
    }
});
// --- END SESSION CHANGE ---

// Get lecture text content for AI processing
// --- SESSION CHANGE - Add isAuthenticated middleware ---
app.get('/lectures/:id/text', isAuthenticated, async (req, res) => {
    try {
        const lecture = await lectureCollection.findById(req.params.id)
            .select('extractedText title textLength professorId') // Select professorId to check ownership

        if (!lecture) {
            return res.status(404).json({
                success: false,
                message: 'Lecture not found'
            })
        }

        // Optional: Add ownership check
        if (req.session.userType === 'teacher' && !lecture.professorId.equals(req.session.userId)) {
             return res.status(403).json({ success: false, message: 'Access denied. You do not own this lecture.' });
        }


        res.json({
            success: true,
            data: {
                id: lecture._id,
                title: lecture.title,
                textLength: lecture.textLength,
                extractedText: lecture.extractedText
            }
        })
    } catch (error) {
        console.error('❌ Error fetching lecture text:', error)
        res.status(500).json({
            success: false,
            message: 'Error loading lecture text'
        })
    }
})
// --- END SESSION CHANGE ---

// Generate quiz from lecture content - AI integration point
// --- SESSION CHANGE - Add isAuthenticated middleware ---
app.post('/generate_quiz/:id', isAuthenticated, async (req, res) => {
    try {
        const lectureId = req.params.id
        const lecture = await lectureCollection.findById(lectureId)

        if (!lecture) {
            return res.status(404).json({
                success: false,
                message: 'Lecture not found'
            })
        }

        // Optional: Add ownership check for quiz generation
        if (req.session.userType === 'teacher' && !lecture.professorId.equals(req.session.userId)) {
             return res.status(403).json({ success: false, message: 'Access denied. You can only generate quizzes for your own lectures.' });
        }


        await lectureCollection.findByIdAndUpdate(lectureId, {
            processingStatus: 'processing',
            lastProcessed: new Date()
        })

        console.log('🤖 AI Quiz Generation Started:', {
            lecture: lecture.title,
            textLength: lecture.textLength
        })

        const extractedText = lecture.extractedText

        if (!extractedText || extractedText.length < 50) {
            await lectureCollection.findByIdAndUpdate(lectureId, {
                processingStatus: 'failed',
                quizGenerated: false
            })
            return res.status(400).json({ success: false, message: 'Extracted text is too short or missing for quiz generation.' })
        }

        // --- PROMPT ENGINEERING ---
        const prompt = `
        You are an intelligent quiz generator. Your task is to create a multiple-choice quiz based on the following lecture content.

        **Instructions:**
        1. Generate 5-7 multiple-choice questions.
        2. Each question should have exactly 4 options (A, B, C, D).
        3. Clearly indicate the correct answer for each question.
        4. Ensure questions and options are directly based on the provided lecture content.
        5. Format the output strictly as a JSON array of objects.

        **Lecture Content:**
        ${extractedText}

        **JSON Output Format Example:**
        [
          {
            "question": "What is the capital of France?",
            "options": {
              "A": "Berlin",
              "B": "Paris",
              "C": "Rome",
              "D": "Madrid"
            },
            "correct_answer": "B"
          },
          {
            "question": "Which planet is known as the Red Planet?",
            "options": {
              "A": "Earth",
              "B": "Mars",
              "C": "Jupiter",
              "D": "Venus"
            },
            "correct_answer": "B"
          }
        ]
        `

        // Configure generation parameters
        const generationConfig = {
            temperature: 0.7,
            topP: 0.95,
            topK: 60,
            maxOutputTokens: 2048,
            responseMimeType: "application/json",
        }

        // Safety settings
        const safetySettings = [
            {
                category: HarmCategory.HARM_CATEGORY_HARASSMENT,
                threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
            },
            {
                category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
                threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
            },
            {
                category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
                threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
            },
            {
                category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
                threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE,
            },
        ]

        // Make the API call
        const result = await model.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig,
            safetySettings,
        })

        const response = result.response
        let quizContent = response.text()

        console.log('✅ Raw AI Response (Quiz Content):', quizContent.substring(0, 500) + '...')

        let generatedQuiz = null
        try {
            if (quizContent.startsWith('```json')) {
                quizContent = quizContent.substring(7, quizContent.lastIndexOf('```')).trim()
            }
            generatedQuiz = JSON.parse(quizContent)
            console.log('✅ Parsed Quiz (first question):', generatedQuiz[0])
        } catch (parseError) {
            console.error('❌ Failed to parse quiz JSON from AI response:', parseError)
            console.error('Raw AI response was:', quizContent)
            await lectureCollection.findByIdAndUpdate(lectureId, {
                processingStatus: 'failed',
                quizGenerated: false,
                quizGenerationError: 'AI response was not valid JSON.'
            })
            return res.status(500).json({ success: false, message: 'AI failed to generate quiz in the correct format. Please try again or refine prompt.' })
        }

        const newQuiz = {
            lectureId: lectureId,
            lectureTitle: lecture.title,
            questions: generatedQuiz,
            totalQuestions: generatedQuiz.length,
            generatedDate: new Date(),
        }

        await quizCollection.create(newQuiz)

        await lectureCollection.findByIdAndUpdate(lectureId, {
            quizGenerated: true,
            processingStatus: 'completed',
            quizzesCount: (lecture.quizzesCount || 0) + 1
        })

        console.log('✅ Quiz generation completed and saved for:', lecture.title)

        res.json({
            success: true,
            message: 'Quiz generated successfully and saved!',
            quizId: newQuiz._id,
            totalQuestions: newQuiz.totalQuestions,
            title: lecture.title
        })

    } catch (error) {
        console.error('❌ Error generating quiz:', error)

        await lectureCollection.findByIdAndUpdate(req.params.id, {
            processingStatus: 'failed',
            quizGenerated: false,
            quizGenerationError: error.message
        })

        res.status(500).json({ success: false, message: 'Failed to generate quiz: ' + error.message })
    }
})
// --- END SESSION CHANGE ---


// Delete lecture and associated quizzes
// --- SESSION CHANGE - Add isAuthenticated middleware ---
app.post('/delete_lecture/:id', isAuthenticated, async (req, res) => {
    try {
        const lectureId = req.params.id
        const lecture = await lectureCollection.findById(lectureId)

        if (!lecture) {
            return res.status(404).json({
                success: false,
                message: 'Lecture not found'
            })
        }

        // Optional: Add ownership check for deletion
        if (req.session.userType === 'teacher' && !lecture.professorId.equals(req.session.userId)) {
             return res.status(403).json({ success: false, message: 'Access denied. You can only delete your own lectures.' });
        }


        // Delete associated quizzes first
        await quizCollection.deleteMany({ lectureId: lectureId })
        // Delete associated quiz results
        await quizResultCollection.deleteMany({ lectureId: lectureId })

        // Removed: Delete the actual file from the file system, as it's no longer stored permanently
        // if (lecture.filePath && fs.existsSync(lecture.filePath)) {
        //     fs.unlinkSync(lecture.filePath);
        //     console.log(`🗑️ Deleted physical file: ${lecture.filePath}`);
        // }

        // Delete lecture record
        await lectureCollection.findByIdAndDelete(lectureId)

        console.log('🗑️ Lecture, quizzes, and results deleted:', lecture.title)

        res.json({
            success: true,
            message: 'Lecture deleted successfully'
        })
    } catch (error) {
        console.error('❌ Error deleting lecture:', error)
        res.status(500).json({
            success: false,
            message: 'Failed to delete lecture'
        })
    }
})
// --- END SESSION CHANGE ---

// ==================== STUDENT QUIZ ROUTES ====================

// Route to get available quizzes for a student
// --- SESSION CHANGE - Add isAuthenticated middleware ---
app.get('/api/student/available-quizzes', isAuthenticated, async (req, res) => {
    try {
        // Ensure only student users can access this
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Not a student account.' });
        }

        // Find all quizzes that have been generated
        const quizzes = await quizCollection.find({})
                                            .select('lectureTitle totalQuestions lectureId')
                                            .sort({ generatedDate: -1 })
                                            .lean();

        res.json({ success: true, quizzes: quizzes });
    } catch (error) {
        console.error('❌ Error fetching available quizzes for student:', error);
        res.status(500).json({ success: false, message: 'Failed to load available quizzes.' });
    }
});
// --- END SESSION CHANGE ---

// Route to render the quiz taking page
// --- SESSION CHANGE - Add isAuthenticated middleware ---
app.get('/take_quiz/:quizId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).redirect('/login?message=Access denied. Only students can take quizzes.');
        }

        const quizId = req.params.quizId;
        const quiz = await quizCollection.findById(quizId).select('lectureTitle totalQuestions').lean();

        if (!quiz) {
            return res.status(404).send('Quiz not found.');
        }

        res.render('takeQuiz', {
            quiz: quiz,
            userName: req.session.userName // Pass user name to the template
        });

    } catch (error) {
        console.error('❌ Error rendering take quiz page:', error);
        res.status(500).send('Failed to load quiz page.');
    }
});
// --- END SESSION CHANGE ---

// Route to fetch quiz questions for a student (API for takeQuiz.hbs)
// --- SESSION CHANGE - Add isAuthenticated middleware ---
app.get('/api/quiz/:quizId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Only students can access quiz questions.' });
        }

        const quizId = req.params.quizId;
        const quiz = await quizCollection.findById(quizId).select('questions totalQuestions lectureTitle').lean();

        if (!quiz) {
            return res.status(404).json({ success: false, message: 'Quiz not found.' });
        }

        const questionsForClient = quiz.questions.map(q => ({
            question: q.question,
            options: q.options,
        }));

        res.json({
            success: true,
            quiz: {
                _id: quiz._id,
                lectureTitle: quiz.lectureTitle,
                totalQuestions: quiz.totalQuestions,
                questions: questionsForClient
            }
        });

    } catch (error) {
        console.error('❌ Error fetching quiz for student:', error);
        res.status(500).json({ success: false, message: 'Failed to load quiz questions.' });
    }
});
// --- END SESSION CHANGE ---

// Route to submit student quiz answers and score it
// --- SESSION CHANGE - Add isAuthenticated middleware ---
app.post('/api/quiz/submit/:quizId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Only students can submit quizzes.' });
        }

        const quizId = req.params.quizId;
        const { studentAnswers, timeTakenSeconds } = req.body;

        // --- SESSION CHANGE - Get student info from session ---
        const studentId = req.session.userId;
        const studentName = req.session.userName;
        // --- END SESSION CHANGE ---

        const quiz = await quizCollection.findById(quizId).lean();
        if (!quiz) {
            return res.status(404).json({ success: false, message: 'Quiz not found for scoring.' });
        }

        let score = 0;
        const totalQuestions = quiz.totalQuestions;
        const detailedAnswers = [];

        studentAnswers.forEach(sAnswer => {
            const correspondingQuestion = quiz.questions[sAnswer.questionIndex];
            if (correspondingQuestion) {
                const isCorrect = sAnswer.selectedOption === correspondingQuestion.correct_answer;
                if (isCorrect) {
                    score++;
                }
                detailedAnswers.push({
                    questionIndex: sAnswer.questionIndex,
                    question: sAnswer.question,
                    selectedOption: sAnswer.selectedOption,
                    correctOption: correspondingQuestion.correct_answer,
                    isCorrect: isCorrect
                });
            }
        });

        const percentage = (totalQuestions > 0) ? (score / totalQuestions) * 100 : 0;

        const newQuizResult = {
            quizId: quizId,
            lectureId: quiz.lectureId,
            studentId: studentId,
            studentName: studentName,
            score: score,
            totalQuestions: totalQuestions,
            percentage: percentage,
            timeTakenSeconds: timeTakenSeconds,
            submissionDate: new Date(),
            answers: detailedAnswers
        };

        await quizResultCollection.create(newQuizResult);
        console.log(`✅ Quiz result saved for student ${studentName} on quiz ${quiz.lectureTitle}: Score ${score}/${totalQuestions}`);

        res.json({
            success: true,
            message: 'Quiz submitted and scored successfully!',
            score: score,
            totalQuestions: totalQuestions,
            percentage: percentage,
            timeTakenSeconds: timeTakenSeconds,
            quizResultId: newQuizResult._id
        });

    } catch (error) {
        console.error('❌ Error submitting or scoring quiz:', error);
        res.status(500).json({ success: false, message: 'Failed to submit quiz: ' + error.message });
    }
});
// --- END SESSION CHANGE ---

// ==================== TEACHER RESULTS ROUTES ====================

// Route for Teacher to view quiz results for a specific lecture
// --- SESSION CHANGE - Add isAuthenticated middleware ---
app.get('/lecture_results/:lectureId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).redirect('/login?message=Access denied. Only teachers can view lecture results.');
        }

        const lectureId = req.params.lectureId;
        const lecture = await lectureCollection.findById(lectureId).lean();
        if (!lecture) {
            return res.status(404).send('Lecture not found.');
        }

        // Optional: Ensure teacher can only view results for their own lectures
        if (!lecture.professorId.equals(req.session.userId)) {
             return res.status(403).send('Access denied. You can only view results for your own lectures.');
        }

        const quizResults = await quizResultCollection.find({ lectureId: lectureId })
                                                     .sort({ submissionDate: -1 })
                                                     .lean();

        const formattedResults = quizResults.map(result => ({
            ...result,
            submissionDate: result.submissionDate.toLocaleString()
        }));

        res.render('lectureResults', {
            lectureTitle: lecture.title,
            quizResults: formattedResults,
            userName: req.session.userName || "Teacher" // Get from session
        });

    } catch (error) {
        console.error('❌ Error fetching lecture results:', error);
        res.status(500).send('Failed to load quiz results.');
    }
});
// --- END SESSION CHANGE ---


// ==================== ERROR HANDLING ====================

// Multer error handling middleware (should be placed after routes that use multer)
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            // Redirect with error message for dashboards, not JSON
            const redirectUrl = req.session.userType === 'teacher' ? '/homeTeacher' : '/login';
            const message = encodeURIComponent('File too large. Maximum size is 10MB.');
            return res.status(400).redirect(`${redirectUrl}?uploadError=true&message=${message}`);
        }
        const redirectUrl = req.session.userType === 'teacher' ? '/homeTeacher' : '/login';
        const message = encodeURIComponent('File upload error: ' + error.message);
        return res.status(400).redirect(`${redirectUrl}?uploadError=true&message=${message}`);
    }

    if (req.fileError) {
        const redirectUrl = req.session.userType === 'teacher' ? '/homeTeacher' : '/login';
        const message = encodeURIComponent(req.fileError.message);
        return res.status(400).redirect(`${redirectUrl}?uploadError=true&message=${message}`);
    }

    next(error)
})


// ==================== SERVER STARTUP ====================

app.listen(PORT, () => {
    console.log(`🚀 QuizAI Server started on port ${PORT}`)

    cleanupTempFiles()
    // Removed: creation of UPLOADS_DIR (No longer needed)
    // if (!fs.existsSync(UPLOADS_DIR)) {
    //     fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    // }

    console.log('📚 Ready to process lecture uploads and generate quizzes!')
})