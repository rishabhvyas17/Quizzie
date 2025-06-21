// QuizAI Server - Express.js Application
// Dependencies to install:
// npm i express hbs mongoose multer pdf-parse mammoth pptx2json @google/generative-ai dotenv nodemon express-session connect-mongo
// Run with: nodemon src/index.js

const express = require("express")
const app = express()
const path = require("path")
const hbs = require("hbs")
const multer = require("multer")
const fs = require("fs")
const pdfParse = require("pdf-parse")
const mammoth = require("mammoth")
const session = require('express-session');
const MongoStore = require('connect-mongo'); // ADD THIS LINE for persistent sessions

// Fix for pptx2json import/usage
const { toJson } = require("pptx2json")

// Load environment variables from .env file
require('dotenv').config()

// Import database collections
const { studentCollection, teacherCollection, lectureCollection, quizCollection, quizResultCollection, explanationCacheCollection } = require("./mongodb")

// Google Gemini API setup
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai')
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" })

// Configuration
const PORT = process.env.PORT || 3000
const TEMP_UPLOAD_DIR = './temp_uploads'
const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100MB
const templatePath = path.join(__dirname, '../tempelates')

// Express configuration
app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.set("view engine", "hbs")
app.set("views", templatePath)

// Configure and use express-session middleware with MongoStore
app.use(session({
    secret: process.env.SESSION_SECRET, // IMPORTANT: Ensure this env var is set in Render/GCP
    resave: false, // Prevents session from being saved back to the session store on every request
    saveUninitialized: false, // Prevents uninitialized sessions from being saved to the store
    store: MongoStore.create({
        mongoUrl: process.env.MONGODB_URI, // CRITICAL: Use your Atlas URI for session storage
        ttl: 14 * 24 * 60 * 60, // Session will expire after 14 days (in seconds)
        autoRemove: 'interval', // Auto-remove expired sessions
        autoRemoveInterval: 10 // In minutes. MongoStore will clean up expired sessions every 10 minutes.
    }),
    cookie: {
        maxAge: 1000 * 60 * 60 * 24 * 14, // 14 days in milliseconds
        secure: true, // IMPORTANT: Set to true in production (requires HTTPS, which Render/GCP provide)
        httpOnly: true, // Prevents client-side JavaScript from accessing the cookie
        sameSite: 'lax' // Recommended for security: 'strict', 'lax', or 'none'. 'lax' is often a good balance.
    }
}));

// Middleware to check if user is authenticated
const isAuthenticated = (req, res, next) => {
    if (req.session.userId) {
        next();
    } else {
        res.redirect('/login?message=Please login to access this page.');
    }
};

const requireAuth = (req, res, next) => {
    if (req.session && req.session.userId) {
        return next();
    } else {
        return res.status(401).json({ success: false, message: 'Authentication required' });
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
        'application/vnd.ms-powerpoint',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
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

async function extractTextFromPowerPoint(filePath) {
    try {
        const data = await toJson(filePath)
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

app.get("/", (req, res) => {
    res.redirect("/login")
})

app.get("/login", (req, res) => {
    res.render("login", { message: req.query.message });
})

app.get("/signup", (req, res) => {
    res.render("signup")
})

app.post("/signup", async (req, res) => {
    try {
        const { userType, name, email, enrollment, password } = req.body

        if (userType === 'teacher') {
            const teacherData = { name, email, password }
            await teacherCollection.insertMany([teacherData])
            const newTeacher = await teacherCollection.findOne({ email: email });
            req.session.userId = newTeacher._id;
            req.session.userName = newTeacher.name;
            req.session.userType = userType;
            res.redirect(`/homeTeacher?userName=${encodeURIComponent(newTeacher.name)}`);
        } else {
            const studentData = { name, enrollment, password }
            await studentCollection.insertMany([studentData])
            const newStudent = await studentCollection.findOne({ enrollment: enrollment });
            req.session.userId = newStudent._id;
            req.session.userName = newStudent.name;
            req.session.userType = userType;
            res.redirect(`/homeStudent?userName=${encodeURIComponent(newStudent.name)}`);
        }
    } catch (error) {
        console.error('❌ Signup error:', error)
        res.send("Error during registration: " + error.message)
    }
})

app.post("/login", async (req, res) => {
    try {
        const { password, userType, email, enrollment } = req.body
        let user

        if (userType === 'teacher') {
            user = await teacherCollection.findOne({ email: email })
        } else {
            user = await studentCollection.findOne({ enrollment: enrollment })
        }

        if (user && user.password === password) {
            req.session.userId = user._id;
            req.session.userName = user.name;
            req.session.userType = userType;

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

app.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Error destroying session:', err);
            return res.status(500).send('Could not log out.');
        }
        res.redirect('/login?message=You have been logged out.');
    });
})

// ==================== DASHBOARD ROUTES ====================

app.get("/homeStudent", isAuthenticated, async (req, res) => {
    res.render("homeStudent", {
        userType: req.session.userType || "student",
        userName: req.session.userName || "Student",
    })
})

app.get("/homeTeacher", isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).redirect('/login?message=Access denied. Not a teacher account.');
        }

        const lectures = await lectureCollection.find({ professorId: req.session.userId }).sort({ uploadDate: -1 }).lean()

        const stats = {
            totalLectures: lectures.length,
            quizzesGenerated: lectures.filter(lecture => lecture.quizGenerated).length,
            pendingLectures: lectures.filter(lecture => !lecture.quizGenerated).length,
            totalStudents: await studentCollection.countDocuments()
        }

        const formattedLectures = lectures.map(lecture => ({
            id: lecture._id,
            title: lecture.title,
            uploadDate: lecture.uploadDate ? lecture.uploadDate.toLocaleDateString() : 'N/A',
            quizGenerated: lecture.quizGenerated,
            originalFileName: lecture.originalFileName,
            fileType: lecture.fileType,
            textLength: lecture.textLength,
            processingStatus: lecture.processingStatus
        }))

        res.render("homeTeacher", {
            userType: req.session.userType || "teacher",
            userName: req.session.userName || "Teacher",
            ...stats,
            lectures: formattedLectures,
            uploadSuccess: req.query.upload === 'success',
            uploadError: req.query.uploadError === 'true',
            message: req.query.message,
            uploadedTitle: req.query.title
        })
    } catch (error) {
        console.error('❌ Error loading teacher dashboard:', error)
        res.status(500).render("homeTeacher", {
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

app.post("/upload_lecture", isAuthenticated, upload.single('lectureFile'), async (req, res) => {
    let tempFilePath = null;

    try {
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

        const professorId = req.session.userId;
        const professorName = req.session.userName;

        if (!professorId || !professorName || req.session.userType !== 'teacher') {
            console.warn('⚠️ User not identified as a teacher in session for lecture upload.');
            return req.session.destroy(err => {
                const message = encodeURIComponent('Authentication required. Please log in as a teacher.');
                res.status(401).redirect(`/login?message=${message}`);
            });
        }

        const extractedText = await extractTextFromFile(file.path, file.mimetype);

        console.log('📝 Text extraction completed:', {
            totalLength: extractedText.length,
            preview: extractedText.substring(0, 200) + '...'
        });

        cleanupTempFile(tempFilePath);
        console.log(`🗑️ Temporary file cleaned up after extraction.`);

        const lectureData = {
            title: title,
            filePath: '',
            originalFileName: file.originalname,
            mimeType: file.mimetype,
            fileSize: file.size,
            extractedText: extractedText,
            textLength: extractedText.length,
            uploadDate: new Date(),
            fileType: getFileType(file.mimetype),
            quizGenerated: false,
            processingStatus: 'completed',
            professorName: professorName,
            professorId: professorId
        };

        const savedLecture = await lectureCollection.create(lectureData);
        console.log('✅ Lecture saved to database:', savedLecture._id);

        res.redirect(`/homeTeacher?upload=success&title=${encodeURIComponent(title)}`);

    } catch (error) {
        console.error('❌ Upload processing error:', error);

        if (tempFilePath && fs.existsSync(tempFilePath)) {
            cleanupTempFile(tempFilePath);
        }

        res.status(500).redirect(`/homeTeacher?uploadError=true&message=${encodeURIComponent('Failed to process uploaded file: ' + error.message)}`);
    }
});

app.get('/lectures/:id/text', isAuthenticated, async (req, res) => {
    try {
        const lecture = await lectureCollection.findById(req.params.id)
            .select('extractedText title textLength professorId')

        if (!lecture) {
            return res.status(404).json({
                success: false,
                message: 'Lecture not found'
            })
        }

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

// ==================== ENHANCED QUIZ GENERATION ROUTE ====================

app.post('/generate_quiz/:id', isAuthenticated, async (req, res) => {
    try {
        const lectureId = req.params.id
        console.log(`🔄 Starting ENHANCED quiz generation for lecture ID: ${lectureId}`)
        
        const lecture = await lectureCollection.findById(lectureId)

        if (!lecture) {
            return res.status(404).json({
                success: false,
                message: 'Lecture not found'
            })
        }

        // Check ownership
        if (req.session.userType === 'teacher' && !lecture.professorId.equals(req.session.userId)) {
             return res.status(403).json({ success: false, message: 'Access denied. You can only generate quizzes for your own lectures.' });
        }

        // Check if quiz already exists
        const existingQuiz = await quizCollection.findOne({ lectureId: lectureId })
        if (existingQuiz) {
            return res.status(400).json({
                success: false,
                message: 'Quiz already generated for this lecture'
            })
        }

        // Update lecture status to processing
        await lectureCollection.findByIdAndUpdate(lectureId, {
            processingStatus: 'processing',
            lastProcessed: new Date()
        })

        console.log('🤖 ENHANCED AI Quiz Generation Started for:', lecture.title)

        const extractedText = lecture.extractedText

        if (!extractedText || extractedText.length < 50) {
            await lectureCollection.findByIdAndUpdate(lectureId, {
                processingStatus: 'failed',
                quizGenerated: false,
                quizGenerationError: 'Text too short for quiz generation'
            })
            return res.status(400).json({ 
                success: false, 
                message: 'Extracted text is too short or missing for quiz generation.' 
            })
        }

        // ENHANCED PROMPT - Generates questions with detailed explanations
        const prompt = `
        You are an expert quiz generator and educational content creator. Create a comprehensive multiple-choice quiz with detailed explanations based on the following lecture content.

        **STRICT REQUIREMENTS:**
        1. Generate exactly 10 multiple-choice questions
        2. Each question must have exactly 4 options (A, B, C, D)
        3. Questions should test understanding, not just memorization
        4. Mix difficulty levels: 3 easy, 4 medium, 3 hard questions
        5. Ensure all questions are directly based on the lecture content
        6. Make wrong options plausible but clearly incorrect
        7. Provide detailed explanations for EACH wrong answer option
        8. Provide a comprehensive explanation for the correct answer
        9. Output must be valid JSON only, no extra text

        **LECTURE CONTENT:**
        ${extractedText.substring(0, 4000)}

        **REQUIRED JSON FORMAT - MUST INCLUDE EXPLANATIONS:**
        [
          {
            "question": "Clear, complete question text here?",
            "options": {
              "A": "First option",
              "B": "Second option", 
              "C": "Third option",
              "D": "Fourth option"
            },
            "correct_answer": "B",
            "correctAnswerExplanation": "Detailed explanation of why B is correct, referencing specific content from the lecture.",
            "explanations": {
              "A": "Explanation of why A is incorrect and what concept it might confuse with specific reference to lecture content",
              "B": "",
              "C": "Explanation of why C is incorrect and what the student might have misunderstood, with reference to lecture material",
              "D": "Explanation of why D is incorrect and how to avoid this mistake, connecting to lecture concepts"
            }
          }
        ]

        **EXPLANATION GUIDELINES:**
        - Each wrong answer explanation should be 2-3 sentences
        - Reference specific concepts from the lecture material provided
        - Explain the common misconception or mistake
        - Provide educational guidance on the correct concept
        - Use encouraging and educational tone
        - The correct answer should have empty string in explanations object
        - Use correctAnswerExplanation field for detailed explanation of correct answer
        - All explanations must be educational and helpful for learning

        Generate exactly 10 questions following this format with comprehensive explanations for each wrong answer.`

        try {
            const generationConfig = {
                temperature: 0.3,
                topP: 0.8,
                topK: 40,
                maxOutputTokens: 8192, // Increased for explanations
                responseMimeType: "application/json",
            }

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

            console.log('📤 Sending ENHANCED request to Gemini API...')
            
            const result = await model.generateContent({
                contents: [{ role: "user", parts: [{ text: prompt }] }],
                generationConfig,
                safetySettings,
            })

            const response = result.response
            let quizContent = response.text()

            console.log('✅ Received ENHANCED response from Gemini API')

            // Parse and validate the AI response
            let generatedQuiz = null
            try {
                quizContent = quizContent.trim()
                if (quizContent.startsWith('```json')) {
                    quizContent = quizContent.substring(7, quizContent.lastIndexOf('```')).trim()
                }
                
                generatedQuiz = JSON.parse(quizContent)
                
                // Enhanced validation
                if (!Array.isArray(generatedQuiz)) {
                    throw new Error('Response is not an array')
                }
                
                if (generatedQuiz.length === 0) {
                    throw new Error('No questions generated')
                }
                
                // Validate each question WITH explanations
                generatedQuiz.forEach((q, index) => {
                    if (!q.question || !q.options || !q.correct_answer || !q.explanations || !q.correctAnswerExplanation) {
                        throw new Error(`Question ${index + 1} is missing required fields (including explanations)`)
                    }
                    if (!['A', 'B', 'C', 'D'].includes(q.correct_answer)) {
                        throw new Error(`Question ${index + 1} has invalid correct_answer`)
                    }
                    
                    // Validate explanations exist for wrong answers
                    ['A', 'B', 'C', 'D'].forEach(option => {
                        if (option !== q.correct_answer && (!q.explanations[option] || q.explanations[option].trim() === '')) {
                            console.warn(`⚠️ Question ${index + 1}: Missing explanation for wrong answer ${option}`);
                            // Set fallback explanation
                            q.explanations[option] = `This option is incorrect. The correct answer is ${q.correct_answer}. Please review the lecture material for more details.`;
                        }
                    });
                    
                    // Ensure correct answer has empty explanation in explanations object
                    q.explanations[q.correct_answer] = "";
                })
                
                console.log('🎯 ENHANCED quiz validated:', {
                    totalQuestions: generatedQuiz.length,
                    hasExplanations: !!generatedQuiz[0].explanations,
                    hasCorrectExplanation: !!generatedQuiz[0].correctAnswerExplanation,
                    sampleExplanation: generatedQuiz[0].explanations[Object.keys(generatedQuiz[0].explanations).find(key => key !== generatedQuiz[0].correct_answer)]?.substring(0, 100) + '...'
                });
                
            } catch (parseError) {
                console.error('❌ Failed to parse ENHANCED quiz JSON:', parseError)
                console.error('Raw response sample:', quizContent.substring(0, 500) + '...')
                
                await lectureCollection.findByIdAndUpdate(lectureId, {
                    processingStatus: 'failed',
                    quizGenerated: false,
                    quizGenerationError: 'Enhanced AI response parsing failed: ' + parseError.message
                })
                
                return res.status(500).json({ 
                    success: false, 
                    message: 'Failed to parse enhanced AI response. Please try again.' 
                })
            }

            // Save the ENHANCED quiz to database
            const newQuiz = {
                lectureId: lectureId,
                lectureTitle: lecture.title,
                questions: generatedQuiz, // Now includes detailed explanations!
                totalQuestions: generatedQuiz.length,
                generatedDate: new Date(),
                createdBy: req.session.userId
            }

            try {
                const savedQuiz = await quizCollection.create(newQuiz)
                console.log('✅ ENHANCED quiz saved to database:', savedQuiz._id)
                
                // Verify explanations were saved correctly
                const verifyQuiz = await quizCollection.findById(savedQuiz._id)
                if (verifyQuiz && verifyQuiz.questions[0].explanations) {
                    console.log('✅ VERIFIED: Quiz with explanations saved successfully!')
                    console.log('📊 First question explanations:', {
                        hasExplanationsField: !!verifyQuiz.questions[0].explanations,
                        explanationCount: Object.keys(verifyQuiz.questions[0].explanations).length,
                        hasCorrectExplanation: !!verifyQuiz.questions[0].correctAnswerExplanation,
                        sampleExplanation: Object.values(verifyQuiz.questions[0].explanations).find(exp => exp && exp.trim() !== '')?.substring(0, 50) + '...'
                    });
                } else {
                    console.log('❌ ERROR: Quiz explanations not saved properly!')
                    throw new Error('Quiz explanations verification failed')
                }
                
                // Update lecture status
                await lectureCollection.findByIdAndUpdate(lectureId, {
                    quizGenerated: true,
                    processingStatus: 'completed',
                    quizzesCount: 1,
                    lastProcessed: new Date()
                })

                console.log('✅ ENHANCED quiz generation completed successfully for:', lecture.title)

                res.json({
                    success: true,
                    message: `Enhanced quiz generated successfully with ${generatedQuiz.length} questions and detailed explanations!`,
                    quizId: savedQuiz._id,
                    totalQuestions: generatedQuiz.length,
                    title: lecture.title,
                    explanationsGenerated: true
                })
                
            } catch (saveError) {
                console.error('❌ Error saving ENHANCED quiz to MongoDB:', saveError)
                
                await lectureCollection.findByIdAndUpdate(lectureId, {
                    processingStatus: 'failed',
                    quizGenerated: false,
                    quizGenerationError: 'Enhanced database save error: ' + saveError.message
                })
                
                return res.status(500).json({ 
                    success: false, 
                    message: 'Failed to save enhanced quiz to database: ' + saveError.message 
                })
            }

        } catch (apiError) {
            console.error('❌ ENHANCED Gemini API Error:', apiError)

            await lectureCollection.findByIdAndUpdate(lectureId, {
                processingStatus: 'failed',
                quizGenerated: false,
                quizGenerationError: 'Enhanced AI API Error: ' + apiError.message
            })

            if (apiError.message.includes('quota') || apiError.message.includes('limit')) {
                return res.status(429).json({ 
                    success: false, 
                    message: 'API quota exceeded. Please try again later.' 
                })
            }

            res.status(500).json({ 
                success: false, 
                message: 'Failed to generate enhanced quiz. Please check your API key and try again.' 
            })
        }
    
    } catch (error) {
        console.error('❌ ENHANCED quiz generation error:', error)
        
        if (req.params.id) {
            await lectureCollection.findByIdAndUpdate(req.params.id, {
                processingStatus: 'failed',
                quizGenerated: false,
                quizGenerationError: error.message
            })
        }

        res.status(500).json({ 
            success: false, 
            message: 'Failed to generate enhanced quiz: ' + error.message 
        })
    }
})

// ==================== DELETE LECTURE ROUTE ====================

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

        if (req.session.userType === 'teacher' && !lecture.professorId.equals(req.session.userId)) {
             return res.status(403).json({ success: false, message: 'Access denied. You can only delete your own lectures.' });
        }

        // Delete associated quizzes first
        await quizCollection.deleteMany({ lectureId: lectureId })
        // Delete associated quiz results
        await quizResultCollection.deleteMany({ lectureId: lectureId })

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

// ==================== STUDENT QUIZ ROUTES ====================

app.get('/api/student/available-quizzes', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Not a student account.' });
        }

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
            userName: req.session.userName
        });

    } catch (error) {
        console.error('❌ Error rendering take quiz page:', error);
        res.status(500).send('Failed to load quiz page.');
    }
});

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

        // Only send question text and options to students (not correct answers or explanations)
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

app.post('/api/quiz/submit/:quizId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Only students can submit quizzes.' });
        }

        const quizId = req.params.quizId;
        const { studentAnswers, timeTakenSeconds } = req.body;

        const studentId = req.session.userId;
        const studentName = req.session.userName;

        // Get complete quiz data including lecture ID
        const quiz = await quizCollection.findById(quizId).lean();
        if (!quiz) {
            return res.status(404).json({ success: false, message: 'Quiz not found for scoring.' });
        }

        let score = 0;
        const totalQuestions = quiz.totalQuestions;
        const detailedAnswers = [];
        const enhancedQuestionDetails = []; // For detailed results page

        // Score the quiz and prepare detailed results
        studentAnswers.forEach(sAnswer => {
            const correspondingQuestion = quiz.questions[sAnswer.questionIndex];
            if (correspondingQuestion) {
                const isCorrect = sAnswer.selectedOption === correspondingQuestion.correct_answer;
                if (isCorrect) {
                    score++;
                }
                
                // For quiz results storage
                detailedAnswers.push({
                    questionIndex: sAnswer.questionIndex,
                    question: sAnswer.question,
                    selectedOption: sAnswer.selectedOption,
                    correctOption: correspondingQuestion.correct_answer,
                    isCorrect: isCorrect
                });

                // Enhanced data for results page with all question details
                enhancedQuestionDetails.push({
                    questionIndex: sAnswer.questionIndex,
                    questionText: correspondingQuestion.question,
                    options: correspondingQuestion.options,
                    studentAnswer: sAnswer.selectedOption,
                    correctAnswer: correspondingQuestion.correct_answer,
                    isCorrect: isCorrect
                });
            }
        });

        const percentage = (totalQuestions > 0) ? (score / totalQuestions) * 100 : 0;

        // Save quiz result to database
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

        // Return enhanced response with all needed data for explanations
        res.json({
            success: true,
            message: 'Quiz submitted and scored successfully!',
            score: score,
            totalQuestions: totalQuestions,
            percentage: percentage,
            timeTakenSeconds: timeTakenSeconds,
            quizResultId: newQuizResult._id,
            // Add these for the results page
            lectureId: quiz.lectureId,
            quizTitle: quiz.lectureTitle,
            questionDetails: enhancedQuestionDetails,
            quizId: quizId // Include quizId for explanations
        });

    } catch (error) {
        console.error('❌ Error submitting or scoring quiz:', error);
        res.status(500).json({ success: false, message: 'Failed to submit quiz: ' + error.message });
    }
});

// ==================== TEACHER RESULTS ROUTES ====================

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
            userName: req.session.userName || "Teacher"
        });

    } catch (error) {
        console.error('❌ Error fetching lecture results:', error);
        res.status(500).send('Failed to load quiz results.');
    }
});

// ==================== ANALYTICS ROUTES ====================

// Student Performance Analytics
app.get('/api/student/performance-data', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Students only.' });
        }

        const studentId = req.session.userId;
        const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);

        // Get student's quiz results from last 15 days
        const studentResults = await quizResultCollection
            .find({ 
                studentId: studentId,
                submissionDate: { $gte: fifteenDaysAgo }
            })
            .sort({ submissionDate: -1 })
            .populate('quizId', 'lectureTitle')
            .lean();

        // Get all quiz results for class averages (last 15 days)
        const allResults = await quizResultCollection
            .find({ submissionDate: { $gte: fifteenDaysAgo } })
            .lean();

        // Calculate student statistics
        const totalQuizzes = studentResults.length;
        const averageScore = totalQuizzes > 0 
            ? (studentResults.reduce((sum, result) => sum + result.percentage, 0) / totalQuizzes).toFixed(1)
            : 0;

        // Calculate overall class average
        const allScores = allResults.map(r => r.percentage);
        const classAverage = allScores.length > 0 
            ? (allScores.reduce((sum, score) => sum + score, 0) / allScores.length).toFixed(1)
            : 0;

        // Calculate performance trend (last 5 vs previous 5)
        let trendIndicator = '→';
        if (studentResults.length >= 6) {
            const recent5 = studentResults.slice(0, 5).reduce((sum, r) => sum + r.percentage, 0) / 5;
            const previous5 = studentResults.slice(5, 10).reduce((sum, r) => sum + r.percentage, 0) / 5;
            
            if (recent5 > previous5 + 5) trendIndicator = '↗️';
            else if (recent5 < previous5 - 5) trendIndicator = '↘️';
        }

        // Get top 3 performers (by average score in last 15 days)
        const studentPerformances = {};
        allResults.forEach(result => {
            if (!studentPerformances[result.studentId]) {
                studentPerformances[result.studentId] = {
                    studentId: result.studentId,
                    studentName: result.studentName,
                    scores: [],
                    totalQuizzes: 0
                };
            }
            studentPerformances[result.studentId].scores.push(result.percentage);
            studentPerformances[result.studentId].totalQuizzes++;
        });

        const rankedStudents = Object.values(studentPerformances)
            .map(student => ({
                ...student,
                averageScore: student.scores.reduce((sum, score) => sum + score, 0) / student.scores.length
            }))
            .sort((a, b) => b.averageScore - a.averageScore);

        const top3Performers = rankedStudents.slice(0, 3).map((student, index) => ({
            rank: index + 1,
            name: student.studentName,
            averageScore: student.averageScore.toFixed(1),
            totalQuizzes: student.totalQuizzes
        }));

        // Find current student's rank
        const currentStudentRank = rankedStudents.findIndex(s => s.studentId.toString() === studentId.toString()) + 1;

        // Prepare trend data for charts
        const trendData = studentResults.reverse().map(result => ({
            date: result.submissionDate.toLocaleDateString(),
            score: result.percentage,
            quizTitle: result.quizId?.lectureTitle || 'Quiz',
            timeTaken: result.timeTakenSeconds
        }));

        res.json({
            success: true,
            data: {
                studentStats: {
                    totalQuizzes,
                    averageScore: parseFloat(averageScore),
                    classAverage: parseFloat(classAverage),
                    trendIndicator,
                    currentRank: currentStudentRank,
                    totalStudents: rankedStudents.length
                },
                recentResults: studentResults.slice(0, 10).map(result => ({
                    quizTitle: result.quizId?.lectureTitle || 'Quiz',
                    score: result.percentage,
                    submissionDate: result.submissionDate.toLocaleDateString(),
                    timeTaken: Math.floor(result.timeTakenSeconds / 60) + 'm ' + (result.timeTakenSeconds % 60) + 's'
                })),
                trendData,
                top3Performers,
                performanceBreakdown: {
                    excellent: studentResults.filter(r => r.percentage >= 90).length,
                    good: studentResults.filter(r => r.percentage >= 70 && r.percentage < 90).length,
                    average: studentResults.filter(r => r.percentage >= 50 && r.percentage < 70).length,
                    needsImprovement: studentResults.filter(r => r.percentage < 50).length
                }
            }
        });

    } catch (error) {
        console.error('❌ Error fetching student performance:', error);
        res.status(500).json({ success: false, message: 'Failed to load performance data.' });
    }
});

// Teacher Class Analytics


// Helper functions for safe calculations
function safeNumber(value, defaultValue = 0) {
  const num = Number(value);
  return isNaN(num) || !isFinite(num) ? defaultValue : num;
}

function safeToFixed(value, decimals = 2) {
  const num = safeNumber(value, 0);
  return num.toFixed(decimals);
}

function safePercentage(part, total) {
  const p = safeNumber(part, 0);
  const t = safeNumber(total, 1); // Avoid division by zero
  return t === 0 ? 0 : (p / t) * 100;
}

// 🎯 FIXED ANALYTICS ROUTE - USING YOUR COLLECTION NAMES
app.get('/api/teacher/class-analytics', requireAuth, async (req, res) => {
  try {
    console.log('📊 Starting enhanced analytics calculation...');
    const teacherId = req.session.userId;

    // Get all teacher's lectures (using your collection names)
    const lectures = await lectureCollection.find({ professorId: teacherId }).lean();
    console.log(`Found ${lectures.length} lectures`);

    if (lectures.length === 0) {
      return res.json({
        success: true,
        data: getEmptyAnalyticsData()
      });
    }

    const lectureIds = lectures.map(l => l._id);
    
    // Get all quizzes for these lectures (using your collection names)
    const quizzes = await quizCollection.find({ lectureId: { $in: lectureIds } }).lean();
    console.log(`Found ${quizzes.length} quizzes`);

    // Get all quiz results (using your collection names)
    const results = await quizResultCollection.find({ 
      quizId: { $in: quizzes.map(q => q._id) } 
    }).lean();
    console.log(`Found ${results.length} quiz results`);

    // Create quiz lookup map
    const quizMap = {};
    quizzes.forEach(quiz => {
      quizMap[quiz._id.toString()] = quiz;
    });

    // Create lecture lookup map
    const lectureMap = {};
    lectures.forEach(lecture => {
      lectureMap[lecture._id.toString()] = lecture;
    });

    // 📈 CALCULATE BASIC STATS
    const totalQuizzes = quizzes.length;
    const totalResults = results.length;
    
    // Get unique students who took quizzes
    const uniqueStudents = [...new Set(results.map(r => r.studentId.toString()))];
    const totalStudents = uniqueStudents.length;

    // Calculate average score (safe)
    let totalScore = 0;
    let validScores = 0;
    
    results.forEach(result => {
      const score = safeNumber(result.percentage);
      if (score >= 0 && score <= 100) {
        totalScore += score;
        validScores++;
      }
    });

    const averageScore = validScores > 0 ? totalScore / validScores : 0;
    console.log(`📊 Basic stats: ${totalStudents} students, avg score: ${safeToFixed(averageScore)}%`);

    // 🎯 PERFORMANCE DISTRIBUTION DATA
    const performanceDistribution = [];
    const quizPerformanceMap = {};

    // Group results by quiz
    results.forEach(result => {
      const quizId = result.quizId.toString();
      if (!quizPerformanceMap[quizId]) {
        quizPerformanceMap[quizId] = [];
      }
      quizPerformanceMap[quizId].push(safeNumber(result.percentage));
    });

    // Calculate performance distribution for each quiz
    Object.keys(quizPerformanceMap).forEach(quizId => {
      const quiz = quizMap[quizId];
      const scores = quizPerformanceMap[quizId];
      
      if (quiz && scores.length > 0) {
        const excellent = scores.filter(s => s >= 90).length;
        const good = scores.filter(s => s >= 70 && s < 90).length;
        const average = scores.filter(s => s >= 50 && s < 70).length;
        const needsHelp = scores.filter(s => s < 50).length;
        const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
        
        const lecture = lectureMap[quiz.lectureId.toString()];
        const lectureTitle = lecture ? lecture.title : 'Unknown Lecture';
        
        performanceDistribution.push({
          quizTitle: quiz.lectureTitle && quiz.lectureTitle.length > 20 ? quiz.lectureTitle.substring(0, 20) + '...' : (quiz.lectureTitle || 'Quiz'),
          fullTitle: `${lectureTitle} - ${quiz.lectureTitle || 'Quiz'}`,
          excellent,
          good,
          average,
          needsHelp,
          totalParticipants: scores.length,
          averageScore: safeToFixed(avgScore, 1)
        });
      }
    });

    console.log(`📊 Performance distribution calculated for ${performanceDistribution.length} quizzes`);

    // 📊 ENGAGEMENT LEVELS DATA
    const studentEngagement = {};
    
    // Calculate engagement for each student
    uniqueStudents.forEach(studentId => {
      const studentResults = results.filter(r => r.studentId.toString() === studentId);
      const participationRate = (studentResults.length / totalQuizzes) * 100;
      
      studentEngagement[studentId] = {
        participationRate: safeNumber(participationRate),
        totalQuizzes: studentResults.length,
        averageScore: studentResults.length > 0 
          ? studentResults.reduce((sum, r) => sum + safeNumber(r.percentage), 0) / studentResults.length 
          : 0
      };
    });

    // Categorize students by engagement
    const engagementLevels = {
      highlyActive: 0,      // 80%+ participation
      moderatelyActive: 0,  // 50-79% participation
      lowActivity: 0,       // 20-49% participation
      inactive: 0           // <20% participation
    };

    Object.values(studentEngagement).forEach(engagement => {
      const rate = engagement.participationRate;
      if (rate >= 80) engagementLevels.highlyActive++;
      else if (rate >= 50) engagementLevels.moderatelyActive++;
      else if (rate >= 20) engagementLevels.lowActivity++;
      else engagementLevels.inactive++;
    });

    console.log(`📊 Engagement levels calculated`);

    // 🏆 TOP PERFORMERS AND INSIGHTS
    const studentPerformance = {};
    
    results.forEach(result => {
      const studentId = result.studentId.toString();
      const score = safeNumber(result.percentage);
      const studentName = result.studentName || `Student ${studentId.slice(-4)}`;
      
      if (!studentPerformance[studentId]) {
        studentPerformance[studentId] = {
          studentId,
          studentName,
          totalScore: 0,
          quizCount: 0,
          scores: [],
          totalTime: 0
        };
      }
      
      studentPerformance[studentId].totalScore += score;
      studentPerformance[studentId].quizCount++;
      studentPerformance[studentId].scores.push(score);
      studentPerformance[studentId].totalTime += safeNumber(result.timeTakenSeconds, 0);
    });

    // Calculate student rankings
    const rankedStudents = Object.values(studentPerformance)
      .map((student, index) => ({
        rank: index + 1, // Will be recalculated after sorting
        studentId: student.studentId,
        studentName: student.studentName,
        averageScore: student.quizCount > 0 ? safeToFixed(student.totalScore / student.quizCount, 1) : '0.0',
        totalQuizzes: student.quizCount,
        averageTime: student.quizCount > 0 ? formatTime(student.totalTime / student.quizCount) : '0:00',
        participationRate: safeToFixed(safePercentage(student.quizCount, totalQuizzes), 1)
      }))
      .sort((a, b) => safeNumber(b.averageScore) - safeNumber(a.averageScore))
      .map((student, index) => ({ ...student, rank: index + 1 }));

    // Top 5 performers for insights
    const topPerformers = rankedStudents.slice(0, 5);

    // Students needing attention (low participation or low scores)
    const studentsNeedingAttention = rankedStudents
      .filter(student => 
        safeNumber(student.averageScore) < 60 || 
        safeNumber(student.participationRate) < 50
      )
      .slice(0, 5);

    // Quiz insights
    const mostChallengingQuiz = performanceDistribution.length > 0 ? 
      performanceDistribution.sort((a, b) => safeNumber(a.averageScore) - safeNumber(b.averageScore))[0] : null;
    
    const bestPerformingQuiz = performanceDistribution.length > 0 ? 
      performanceDistribution.sort((a, b) => safeNumber(b.averageScore) - safeNumber(a.averageScore))[0] : null;

    console.log(`🏆 Student rankings calculated: ${rankedStudents.length} students`);

    // 📅 RECENT ACTIVITY (Last 10 submissions)
    const recentActivity = results
      .sort((a, b) => new Date(b.submissionDate) - new Date(a.submissionDate))
      .slice(0, 10)
      .map(result => {
        const quiz = quizMap[result.quizId.toString()];
        const lecture = quiz ? lectureMap[quiz.lectureId.toString()] : null;
        
        return {
          studentName: result.studentName || 'Unknown Student',
          quizTitle: quiz ? 
            (quiz.lectureTitle && quiz.lectureTitle.length > 30 ? quiz.lectureTitle.substring(0, 30) + '...' : quiz.lectureTitle || 'Quiz') 
            : 'Unknown Quiz',
          fullQuizTitle: quiz ? `${lecture?.title || 'Unknown'} - ${quiz.lectureTitle || 'Quiz'}` : 'Unknown Quiz',
          score: safeToFixed(result.percentage, 1),
          submissionDate: new Date(result.submissionDate).toLocaleDateString(),
          timeTaken: formatTime(result.timeTakenSeconds)
        };
      });

    // 🎯 QUIZ PERFORMANCE SUMMARY
    const quizPerformance = performanceDistribution.map(quiz => ({
      quizTitle: quiz.quizTitle,
      fullTitle: quiz.fullTitle,
      participants: quiz.totalParticipants,
      averageScore: quiz.averageScore,
      highestScore: safeToFixed(Math.max(...(quizPerformanceMap[Object.keys(quizMap).find(id => 
        (quizMap[id].lectureTitle === quiz.quizTitle) || 
        quiz.fullTitle.includes(quizMap[id].lectureTitle || '')
      )] || [0])), 1),
      lowestScore: safeToFixed(Math.min(...(quizPerformanceMap[Object.keys(quizMap).find(id => 
        (quizMap[id].lectureTitle === quiz.quizTitle) || 
        quiz.fullTitle.includes(quizMap[id].lectureTitle || '')
      )] || [0])), 1)
    }));

    // 📊 CLASS HEALTH METRICS
    const classHealthScore = {
      engagement: safeToFixed(safePercentage(
        engagementLevels.highlyActive + engagementLevels.moderatelyActive, 
        totalStudents
      ), 1),
      performance: safeToFixed(averageScore, 1),
      participation: safeToFixed(safePercentage(
        rankedStudents.filter(s => safeNumber(s.participationRate) >= 50).length,
        totalStudents
      ), 1)
    };

    // 🎨 CHART METADATA
    const chartMetadata = {
      performanceChart: {
        title: '📊 Student Performance Distribution by Quiz',
        subtitle: 'Number of students in each performance category per quiz',
        colors: {
          excellent: '#10b981',
          good: '#3b82f6',
          average: '#f59e0b',
          needsHelp: '#ef4444'
        }
      },
      engagementChart: {
        title: '👥 Student Engagement Levels',
        subtitle: 'Based on quiz participation rates',
        colors: {
          highlyActive: '#10b981',
          moderatelyActive: '#3b82f6',
          lowActivity: '#f59e0b',
          inactive: '#ef4444'
        }
      }
    };

    // 🎯 FINAL ENHANCED ANALYTICS DATA
    const enhancedAnalyticsData = {
      overallStats: {
        totalStudents,
        totalQuizzes,
        classAverage: safeToFixed(averageScore, 1),
        totalResults
      },
      performanceDistribution,
      engagementLevels,
      insights: {
        classHealthScore,
        topPerformers: topPerformers.map(p => ({ ...p, rank: p.rank })),
        studentsNeedingAttention,
        mostChallengingQuiz,
        bestPerformingQuiz
      },
      rankedStudents,
      recentActivity,
      quizPerformance,
      chartMetadata
    };

    console.log('✅ Enhanced analytics calculation completed successfully');
    console.log('📊 Analytics summary:', {
      totalStudents: enhancedAnalyticsData.overallStats.totalStudents,
      totalQuizzes: enhancedAnalyticsData.overallStats.totalQuizzes,
      classAverage: enhancedAnalyticsData.overallStats.classAverage,
      performanceQuizzes: enhancedAnalyticsData.performanceDistribution.length,
      rankedStudents: enhancedAnalyticsData.rankedStudents.length,
      recentActivity: enhancedAnalyticsData.recentActivity.length
    });

    res.json({
      success: true,
      data: enhancedAnalyticsData
    });

  } catch (error) {
    console.error('❌ Enhanced analytics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to calculate enhanced analytics',
      error: error.message
    });
  }
});

// Individual Student Analytics for Teachers
app.get('/api/teacher/student-analytics/:studentId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).json({ success: false, message: 'Access denied. Teachers only.' });
        }

        const studentId = req.params.studentId;
        const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);

        // Get student info
        const student = await studentCollection.findById(studentId).select('name enrollment').lean();
        if (!student) {
            return res.status(404).json({ success: false, message: 'Student not found.' });
        }

        // Get student's last 10 quiz results
        const studentResults = await quizResultCollection
            .find({ 
                studentId: studentId,
                submissionDate: { $gte: fifteenDaysAgo }
            })
            .sort({ submissionDate: -1 })
            .limit(10)
            .populate('quizId', 'lectureTitle totalQuestions')
            .lean();

        // Get all results for class comparison
        const allResults = await quizResultCollection
            .find({ submissionDate: { $gte: fifteenDaysAgo } })
            .lean();

        // Calculate class averages
        const classAverage = allResults.length > 0 
            ? (allResults.reduce((sum, r) => sum + r.percentage, 0) / allResults.length).toFixed(1)
            : 0;

        // Calculate student's performance metrics
        const totalQuizzes = studentResults.length;
        const averageScore = totalQuizzes > 0 
            ? (studentResults.reduce((sum, result) => sum + result.percentage, 0) / totalQuizzes).toFixed(1)
            : 0;

        const averageTime = totalQuizzes > 0 
            ? Math.floor(studentResults.reduce((sum, result) => sum + result.timeTakenSeconds, 0) / totalQuizzes / 60)
            : 0;

        // Calculate improvement trend
        let trendIndicator = '→';
        if (studentResults.length >= 6) {
            const recent3 = studentResults.slice(0, 3).reduce((sum, r) => sum + r.percentage, 0) / 3;
            const previous3 = studentResults.slice(3, 6).reduce((sum, r) => sum + r.percentage, 0) / 3;
            
            if (recent3 > previous3 + 5) trendIndicator = '↗️';
            else if (recent3 < previous3 - 5) trendIndicator = '↘️';
        }

        // Detailed quiz breakdown
        const detailedResults = studentResults.map(result => ({
            quizTitle: result.quizId?.lectureTitle || 'Quiz',
            score: result.score,
            totalQuestions: result.totalQuestions,
            percentage: result.percentage,
            timeTaken: result.timeTakenSeconds,
            submissionDate: result.submissionDate,
            answers: result.answers
        }));

        res.json({
            success: true,
            data: {
                studentInfo: {
                    name: student.name,
                    enrollment: student.enrollment,
                    studentId: studentId
                },
                performanceMetrics: {
                    totalQuizzes,
                    averageScore: parseFloat(averageScore),
                    classAverage: parseFloat(classAverage),
                    averageTime: averageTime + 'm',
                    trendIndicator
                },
                detailedResults,
                chartData: {
                    scoresTrend: studentResults.reverse().map(r => ({
                        date: r.submissionDate.toLocaleDateString(),
                        score: r.percentage,
                        classAvg: parseFloat(classAverage)
                    })),
                    timeAnalysis: studentResults.map(r => ({
                        quiz: r.quizId?.lectureTitle || 'Quiz',
                        timeMinutes: Math.floor(r.timeTakenSeconds / 60)
                    }))
                }
            }
        });

    } catch (error) {
        console.error('❌ Error fetching student analytics:', error);
        res.status(500).json({ success: false, message: 'Failed to load student analytics.' });
    }
});

// Student Analytics Page for Teachers
app.get('/teacher/student-analytics/:studentId', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'teacher') {
            return res.status(403).redirect('/login?message=Access denied. Teachers only.');
        }

        const studentId = req.params.studentId;
        const student = await studentCollection.findById(studentId).select('name enrollment').lean();
        
        if (!student) {
            return res.status(404).send('Student not found.');
        }

        res.render('studentAnalytics', {
            student: student,
            studentId: studentId,
            userName: req.session.userName
        });

    } catch (error) {
        console.error('❌ Error rendering student analytics page:', error);
        res.status(500).send('Failed to load student analytics page.');
    }
});

// ==================== AI EXPLANATIONS ROUTES ====================

// Enhanced explanation retrieval route
app.post('/api/explanation/get', isAuthenticated, async (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).json({ success: false, message: 'Access denied. Students only.' });
        }

        const { quizId, questionIndex, wrongAnswer } = req.body;

        console.log('🔍 Getting ENHANCED explanation for:', {
            quizId: quizId,
            questionIndex: questionIndex,
            wrongAnswer: wrongAnswer
        });

        // Get the quiz with enhanced explanations
        const quiz = await quizCollection.findById(quizId).lean();
        if (!quiz) {
            return res.status(404).json({ success: false, message: 'Quiz not found.' });
        }

        const question = quiz.questions[questionIndex];
        if (!question) {
            return res.status(404).json({ success: false, message: 'Question not found.' });
        }

        let explanation = null;
        let explanationType = 'detailed';

        // Get the detailed explanation for the wrong answer
        if (question.explanations && question.explanations[wrongAnswer] && question.explanations[wrongAnswer].trim() !== '') {
            explanation = question.explanations[wrongAnswer];
            
            // Also include context about the correct answer
            if (question.correctAnswerExplanation && question.correctAnswerExplanation.trim() !== '') {
                explanation += `\n\n💡 **Why ${question.correct_answer} is correct:** ${question.correctAnswerExplanation}`;
            }
            
            console.log('✅ Retrieved detailed explanation for wrong answer:', wrongAnswer);
        } else {
            // Fallback explanation if detailed ones aren't available
            explanationType = 'basic';
            if (question.correctAnswerExplanation && question.correctAnswerExplanation.trim() !== '') {
                explanation = `The correct answer is ${question.correct_answer}) ${question.options[question.correct_answer]}.\n\n${question.correctAnswerExplanation}`;
            } else {
                explanation = `The correct answer is ${question.correct_answer}) ${question.options[question.correct_answer]}. Please review the lecture material for detailed understanding.`;
            }
            
            console.log('⚠️ Using fallback explanation - detailed explanation not found');
        }

        console.log('✅ Retrieved explanation:', {
            type: explanationType,
            length: explanation.length,
            preview: explanation.substring(0, 100) + '...'
        });

        res.json({
            success: true,
            explanation: explanation,
            cached: true,
            source: 'pre-generated-enhanced',
            explanationType: explanationType,
            questionDetails: {
                correctAnswer: question.correct_answer,
                correctOption: question.options[question.correct_answer],
                wrongOption: question.options[wrongAnswer],
                hasDetailedExplanations: !!(question.explanations && Object.keys(question.explanations).length > 0),
                hasCorrectExplanation: !!(question.correctAnswerExplanation && question.correctAnswerExplanation.trim() !== '')
            }
        });

    } catch (error) {
        console.error('❌ Error retrieving enhanced explanation:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to retrieve explanation: ' + error.message 
        });
    }
});

// Check explanation status for a quiz
app.get('/api/quiz/:quizId/explanations-status', isAuthenticated, async (req, res) => {
    try {
        const quizId = req.params.quizId;
        const quiz = await quizCollection.findById(quizId).select('questions generatedDate').lean();
        
        if (!quiz) {
            return res.status(404).json({ success: false, message: 'Quiz not found.' });
        }

        // Check if questions have enhanced explanations
        const questionsWithExplanations = quiz.questions.filter(q => 
            q.explanations && Object.keys(q.explanations).some(key => q.explanations[key] && q.explanations[key].trim() !== '')
        ).length;

        const questionsWithCorrectExplanations = quiz.questions.filter(q => 
            q.correctAnswerExplanation && q.correctAnswerExplanation.trim() !== ''
        ).length;

        const hasEnhancedExplanations = questionsWithExplanations > 0;

        console.log('📊 Explanation status check:', {
            quizId: quizId,
            totalQuestions: quiz.questions.length,
            questionsWithExplanations: questionsWithExplanations,
            questionsWithCorrectExplanations: questionsWithCorrectExplanations,
            hasEnhancedExplanations: hasEnhancedExplanations
        });

        res.json({
            success: true,
            hasEnhancedExplanations: hasEnhancedExplanations,
            explanationStats: {
                totalQuestions: quiz.questions.length,
                questionsWithExplanations: questionsWithExplanations,
                questionsWithCorrectExplanations: questionsWithCorrectExplanations,
                enhancementLevel: questionsWithExplanations === quiz.questions.length ? 'full' : 
                                questionsWithExplanations > 0 ? 'partial' : 'none'
            },
            generatedDate: quiz.generatedDate
        });

    } catch (error) {
        console.error('❌ Error checking explanation status:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to check explanation status: ' + error.message 
        });
    }
});

// ==================== DEBUG ROUTES (Development Only) ====================

// Debug route to check quiz explanations structure
app.get('/debug/quiz/:quizId', isAuthenticated, async (req, res) => {
    try {
        const quizId = req.params.quizId;
        console.log('🔍 DEBUG: Checking quiz explanations for:', quizId);
        
        const quiz = await quizCollection.findById(quizId).lean();
        
        if (!quiz) {
            return res.json({ error: 'Quiz not found' });
        }

        // Check the structure of the first question
        const firstQuestion = quiz.questions[0];
        
        const debugInfo = {
            quizId: quiz._id,
            lectureTitle: quiz.lectureTitle,
            totalQuestions: quiz.questions.length,
            generatedDate: quiz.generatedDate,
            
            // Check first question structure
            firstQuestionStructure: {
                hasQuestion: !!firstQuestion.question,
                hasOptions: !!firstQuestion.options,
                hasCorrectAnswer: !!firstQuestion.correct_answer,
                hasExplanations: !!firstQuestion.explanations,
                hasCorrectExplanation: !!firstQuestion.correctAnswerExplanation,
                
                // Show actual explanation data
                explanationsData: firstQuestion.explanations || 'NOT FOUND',
                correctExplanationData: firstQuestion.correctAnswerExplanation || 'NOT FOUND'
            },
            
            // Check all questions for explanations
            questionsWithExplanations: quiz.questions.filter(q => 
                q.explanations && Object.keys(q.explanations).length > 0
            ).length,
            
            questionsWithCorrectExplanations: quiz.questions.filter(q => 
                q.correctAnswerExplanation && q.correctAnswerExplanation.trim() !== ''
            ).length,
            
            // Sample of explanations from first question
            sampleExplanations: firstQuestion.explanations ? 
                Object.entries(firstQuestion.explanations).map(([key, value]) => ({
                    option: key,
                    explanation: value ? value.substring(0, 100) + '...' : 'EMPTY'
                })) : 'NO EXPLANATIONS FIELD'
        };

        console.log('📊 DEBUG Results:', debugInfo);
        
        res.json({
            success: true,
            debugInfo: debugInfo,
            recommendation: debugInfo.questionsWithExplanations === 0 ? 
                'ISSUE FOUND: No questions have explanations. You need to generate a NEW quiz with the enhanced system.' :
                'Explanations found! Check the explanation retrieval route.'
        });

    } catch (error) {
        console.error('❌ Debug error:', error);
        res.json({ error: error.message });
    }
});

// Debug route to test a specific question's explanations
app.get('/debug/quiz/:quizId/question/:questionIndex', isAuthenticated, async (req, res) => {
    try {
        const { quizId, questionIndex } = req.params;
        
        const quiz = await quizCollection.findById(quizId).lean();
        if (!quiz) {
            return res.json({ error: 'Quiz not found' });
        }

        const question = quiz.questions[parseInt(questionIndex)];
        if (!question) {
            return res.json({ error: 'Question not found' });
        }

        res.json({
            success: true,
            questionDebug: {
                questionText: question.question,
                options: question.options,
                correctAnswer: question.correct_answer,
                hasExplanations: !!question.explanations,
                explanations: question.explanations || 'NOT FOUND',
                hasCorrectExplanation: !!question.correctAnswerExplanation,
                correctExplanation: question.correctAnswerExplanation || 'NOT FOUND',
                
                // Test each wrong answer explanation
                explanationTests: ['A', 'B', 'C', 'D'].map(option => ({
                    option: option,
                    isCorrectAnswer: option === question.correct_answer,
                    hasExplanation: !!(question.explanations && question.explanations[option]),
                    explanationText: question.explanations && question.explanations[option] ? 
                        question.explanations[option] : 'NO EXPLANATION'
                }))
            }
        });

    } catch (error) {
        console.error('❌ Question debug error:', error);
        res.json({ error: error.message });
    }
});

// ==================== QUIZ RESULTS PAGE ROUTE ====================

app.get('/quiz-results', isAuthenticated, (req, res) => {
    try {
        if (req.session.userType !== 'student') {
            return res.status(403).redirect('/login?message=Access denied. Only students can view quiz results.');
        }

        res.render('quizResults', {
            userName: req.session.userName || 'Student'
        });

    } catch (error) {
        console.error('❌ Error rendering quiz results page:', error);
        res.status(500).send('Failed to load quiz results page.');
    }
});

// ==================== DATA CLEANUP FUNCTIONS ====================

// Function to clean up old quiz results (older than 15 days)
async function cleanupOldQuizResults() {
    try {
        const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
        
        const deleteResult = await quizResultCollection.deleteMany({
            submissionDate: { $lt: fifteenDaysAgo }
        });
        
        console.log(`🗑️ Cleaned up ${deleteResult.deletedCount} old quiz results (older than 15 days)`);
        
    } catch (error) {
        console.error('❌ Error during cleanup:', error);
    }
}

// Function to clean up old unused explanations (run monthly)
async function cleanupOldExplanations() {
    try {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        
        // Delete explanations that haven't been used in 30 days and have usage count of 1
        const deleteResult = await explanationCacheCollection.deleteMany({
            generatedDate: { $lt: thirtyDaysAgo },
            usageCount: 1
        });
        
        console.log(`🗑️ Cleaned up ${deleteResult.deletedCount} unused explanations`);
        
    } catch (error) {
        console.error('❌ Error during explanation cleanup:', error);
    }
}

// ==================== ERROR HANDLING ====================

app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            const redirectUrl = req.session.userType === 'teacher' ? '/homeTeacher' : '/login';
            const message = encodeURIComponent('File too large. Maximum size is 100MB.');
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
    console.log(`📌 Open http://localhost:${PORT} in your browser`)

    // Run cleanup functions on server start
    cleanupTempFiles()
    cleanupOldQuizResults()

    console.log('✅ Server initialization complete!')
    console.log('📚 Ready to process lecture uploads and generate enhanced quizzes!')
    console.log(`🔑 Using Gemini model: gemini-1.5-flash (Free tier)`)
})

// Schedule cleanup functions to run periodically
setInterval(cleanupOldQuizResults, 24 * 60 * 60 * 1000); // Every 24 hours
setInterval(cleanupOldExplanations, 15 * 24 * 60 * 60 * 1000); // Every 15 days


// 🛠️ HELPER FUNCTIONS (Add these at the bottom of your index.js file)

function getEmptyAnalyticsData() {
  return {
    overallStats: {
      totalStudents: 0,
      totalQuizzes: 0,
      classAverage: '0.0',
      totalResults: 0
    },
    performanceDistribution: [],
    engagementLevels: {
      highlyActive: 0,
      moderatelyActive: 0,
      lowActivity: 0,
      inactive: 0
    },
    insights: {
      classHealthScore: {
        engagement: '0.0',
        performance: '0.0',
        participation: '0.0'
      },
      topPerformers: [],
      studentsNeedingAttention: [],
      mostChallengingQuiz: null,
      bestPerformingQuiz: null
    },
    rankedStudents: [],
    recentActivity: [],
    quizPerformance: [],
    chartMetadata: {
      performanceChart: {
        title: '📊 Student Performance Distribution by Quiz',
        subtitle: 'No data available yet',
        colors: {
          excellent: '#10b981',
          good: '#3b82f6',
          average: '#f59e0b',
          needsHelp: '#ef4444'
        }
      },
      engagementChart: {
        title: '👥 Student Engagement Levels',
        subtitle: 'No data available yet',
        colors: {
          highlyActive: '#10b981',
          moderatelyActive: '#3b82f6',
          lowActivity: '#f59e0b',
          inactive: '#ef4444'
        }
      }
    }
  };
}

function formatTime(seconds) {
  const totalSeconds = safeNumber(seconds, 0);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}