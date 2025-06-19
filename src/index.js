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
const session = require('express-session');

// Fix for pptx2json import/usage
const { toJson } = require("pptx2json")

// Load environment variables from .env file
require('dotenv').config()

// Import database collections
const { studentCollection, teacherCollection, lectureCollection, quizCollection, quizResultCollection } = require("./mongodb")

// Google Gemini API setup
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai')
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" })

// Configuration
const PORT = 3000
const TEMP_UPLOAD_DIR = './temp_uploads'
const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100MB
const templatePath = path.join(__dirname, '../tempelates')

// Express configuration
app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.set("view engine", "hbs")
app.set("views", templatePath)

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'a_very_secret_key_for_quizai',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 1000 * 60 * 60 * 24, // 1 day
        httpOnly: true
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

        const currentUserName = req.session.userName || 'Teacher';
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

// ==================== IMPROVED QUIZ GENERATION ROUTE WITH DEBUG LOGGING ====================

app.post('/generate_quiz/:id', isAuthenticated, async (req, res) => {
    try {
        const lectureId = req.params.id
        console.log(`🔄 Starting quiz generation for lecture ID: ${lectureId}`)
        
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

        console.log('🤖 AI Quiz Generation Started for:', lecture.title)

        const extractedText = lecture.extractedText

        // DEBUG: Log extracted text details
        console.log('📊 Extracted text length:', extractedText.length);
        console.log('📝 First 500 chars of text:', extractedText.substring(0, 500));

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

        // Improved prompt for better quiz generation
        const prompt = `
        You are an expert quiz generator. Create a high-quality multiple-choice quiz based on the following lecture content.

        **STRICT REQUIREMENTS:**
        1. Generate exactly 10 multiple-choice questions
        2. Each question must have exactly 4 options (A, B, C, D)
        3. Questions should test understanding, not just memorization
        4. Mix difficulty levels: 3 easy, 4 medium, 3 hard questions
        5. Ensure all questions are directly based on the lecture content
        6. Make wrong options plausible but clearly incorrect
        7. Output must be valid JSON only, no extra text

        **LECTURE CONTENT:**
        ${extractedText.substring(0, 4000)} // Limit text to avoid token limits

        **REQUIRED JSON FORMAT:**
        [
          {
            "question": "Clear, complete question text here?",
            "options": {
              "A": "First option",
              "B": "Second option",
              "C": "Third option",
              "D": "Fourth option"
            },
            "correct_answer": "B"
          }
        ]

        Generate exactly 10 questions following this format.`

        try {
            // Configure generation parameters for consistency
            const generationConfig = {
                temperature: 0.3, // Lower temperature for more consistent output
                topP: 0.8,
                topK: 40,
                maxOutputTokens: 4096,
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

            console.log('📤 Sending request to Gemini API...')
            
            // Make the API call
            const result = await model.generateContent({
                contents: [{ role: "user", parts: [{ text: prompt }] }],
                generationConfig,
                safetySettings,
            })

            const response = result.response
            let quizContent = response.text()

            console.log('✅ Received response from Gemini API')

            // Parse the response
            let generatedQuiz = null
            try {
                // Clean up the response if needed
                quizContent = quizContent.trim()
                if (quizContent.startsWith('```json')) {
                    quizContent = quizContent.substring(7, quizContent.lastIndexOf('```')).trim()
                }
                
                generatedQuiz = JSON.parse(quizContent)
                
                // Validate the quiz structure
                if (!Array.isArray(generatedQuiz)) {
                    throw new Error('Response is not an array')
                }
                
                if (generatedQuiz.length === 0) {
                    throw new Error('No questions generated')
                }
                
                // Validate each question
                generatedQuiz.forEach((q, index) => {
                    if (!q.question || !q.options || !q.correct_answer) {
                        throw new Error(`Question ${index + 1} is missing required fields`)
                    }
                    if (!['A', 'B', 'C', 'D'].includes(q.correct_answer)) {
                        throw new Error(`Question ${index + 1} has invalid correct_answer`)
                    }
                })
                
                // DEBUG: Log parsed quiz details
                console.log('🎯 Number of questions generated:', generatedQuiz.length);
                console.log('📋 First question:', JSON.stringify(generatedQuiz[0], null, 2));
                
            } catch (parseError) {
                console.error('❌ Failed to parse quiz JSON:', parseError)
                console.error('Raw response:', quizContent.substring(0, 500) + '...')
                
                await lectureCollection.findByIdAndUpdate(lectureId, {
                    processingStatus: 'failed',
                    quizGenerated: false,
                    quizGenerationError: 'AI response parsing failed: ' + parseError.message
                })
                
                return res.status(500).json({ 
                    success: false, 
                    message: 'Failed to parse AI response. Please try again.' 
                })
            }

            // Save the quiz to database
            const newQuiz = {
                lectureId: lectureId,
                lectureTitle: lecture.title,
                questions: generatedQuiz,
                totalQuestions: generatedQuiz.length,
                generatedDate: new Date(),
                createdBy: req.session.userId
            }

            try {
                const savedQuiz = await quizCollection.create(newQuiz)
                console.log('✅ Quiz saved to database:', savedQuiz._id)
                
                // DEBUG: Verify the quiz was actually saved
                const verifyQuiz = await quizCollection.findById(savedQuiz._id)
                if (verifyQuiz) {
                    console.log('✅ VERIFIED: Quiz exists in database with ID:', verifyQuiz._id)
                    console.log('📊 Quiz has', verifyQuiz.questions.length, 'questions')
                    
                    // DEBUG: Log saved quiz details
                    console.log('💾 Saved quiz details:', {
                        _id: savedQuiz._id,
                        lectureId: savedQuiz.lectureId,
                        totalQuestions: savedQuiz.totalQuestions,
                        questionsCount: savedQuiz.questions.length
                    });
                } else {
                    console.log('❌ ERROR: Quiz not found after saving!')
                    throw new Error('Quiz verification failed - not found in database after saving')
                }
                
                // Update lecture status
                await lectureCollection.findByIdAndUpdate(lectureId, {
                    quizGenerated: true,
                    processingStatus: 'completed',
                    quizzesCount: 1,
                    lastProcessed: new Date()
                })

                console.log('✅ Quiz generation completed successfully for:', lecture.title)

                res.json({
                    success: true,
                    message: `Quiz generated successfully with ${generatedQuiz.length} questions!`,
                    quizId: savedQuiz._id,
                    totalQuestions: generatedQuiz.length,
                    title: lecture.title
                })
                
            } catch (saveError) {
                console.error('❌ Error saving quiz to MongoDB:', saveError)
                console.error('Full error details:', JSON.stringify(saveError, null, 2))
                
                await lectureCollection.findByIdAndUpdate(lectureId, {
                    processingStatus: 'failed',
                    quizGenerated: false,
                    quizGenerationError: 'Database save error: ' + saveError.message
                })
                
                return res.status(500).json({ 
                    success: false, 
                    message: 'Failed to save quiz to database: ' + saveError.message 
                })
            }

        } catch (apiError) {
            console.error('❌ Gemini API Error:', apiError)
            console.error('Error details:', {
                message: apiError.message,
                stack: apiError.stack
            })

            await lectureCollection.findByIdAndUpdate(lectureId, {
                processingStatus: 'failed',
                quizGenerated: false,
                quizGenerationError: 'AI API Error: ' + apiError.message
            })

            // Check for specific API errors
            if (apiError.message.includes('quota') || apiError.message.includes('limit')) {
                return res.status(429).json({ 
                    success: false, 
                    message: 'API quota exceeded. Please try again later.' 
                })
            }

            res.status(500).json({ 
                success: false, 
                message: 'Failed to generate quiz. Please check your API key and try again.' 
            })
        }
    
    } catch (error) {
        console.error('❌ Quiz generation error:', error)
        
        if (req.params.id) {
            await lectureCollection.findByIdAndUpdate(req.params.id, {
                processingStatus: 'failed',
                quizGenerated: false,
                quizGenerationError: error.message
            })
        }

        res.status(500).json({ 
            success: false, 
            message: 'Failed to generate quiz: ' + error.message 
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

    cleanupTempFiles()

    console.log('✅ Server initialization complete!')
    console.log('📚 Ready to process lecture uploads and generate quizzes!')
    console.log(`🔑 Using Gemini model: gemini-1.5-flash (Free tier)`)
})